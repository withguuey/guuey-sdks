"""guuey_host.creds against the golden corpus the JavaScript reader wrote, plus the no-legacy-fallback guards.

The corpus (../golden/creds/servers-file.json) is written by src/python-golden/creds.golden.test.ts, which lays each
case out in a temp directory and records what @guuey/worker's listCredentials returned. Here each case is laid out the
same way and guuey_host.creds must return the same entries, in the same order, except for the cases named in
DIVERGENT_CASES. Every case runs with the working directory inside the session tree, as a worker runs on a pod, and
its stderr is pinned too: one refusal line for the cases named in REFUSED_CASES, nothing for the rest.

Two divergences from the JavaScript reader are deliberate (see creds.py): no session-folder arm (the corpus holds only
the servers-file arm; NoLegacySessionFolder pins that nothing is read with the variable unset), and the servers file
must be a regular file reached without following a last-component symlink.
"""

import base64
import contextlib
import copy
import inspect
import io
import json
import os
import tempfile
import threading
import unittest
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict
from unittest import mock

from guuey_host.creds import MCP_SERVERS_FILE_ENV, CredentialEntry, CredentialFile, RefusalReason, list_credentials

GOLDEN = Path(__file__).resolve().parent.parent / "golden" / "creds"
# The case count each corpus file must hold at least (the generator writes 49). A missing directory or file raises
# and an empty or shrunken corpus fails: the replay never passes, or skips, on nothing.
MIN_CASES = {"servers-file": 49}
CASE_SETS = tuple(MIN_CASES)
CREDS_SOURCE = Path(__file__).resolve().parent.parent / "guuey_host" / "creds.py"


class TextContent(TypedDict):
    kind: Literal["text"]
    text: str


class BytesContent(TypedDict):
    kind: Literal["bytes"]
    base64: str


class DirectoryNode(TypedDict):
    kind: Literal["directory"]


class SymlinkNode(TypedDict):
    kind: Literal["symlink"]
    target: TextContent | BytesContent


class DanglingSymlinkNode(TypedDict):
    kind: Literal["dangling-symlink"]


type Content = TextContent | BytesContent
type TreeNode = TextContent | BytesContent | DirectoryNode | SymlinkNode | DanglingSymlinkNode


class EmptyEnv(TypedDict):
    kind: Literal["empty"]


class FileEnv(TypedDict):
    kind: Literal["file", "file-trailing-slash"]
    node: TreeNode


class MissingEnv(TypedDict):
    kind: Literal["missing"]


class RelativeEnv(TypedDict):
    kind: Literal["relative-to-session-file"]
    content: Content


class LiteralEnv(TypedDict):
    kind: Literal["literal"]
    value: str


type ServersFileEnv = EmptyEnv | FileEnv | MissingEnv | RelativeEnv | LiteralEnv


class AbsentSession(TypedDict):
    kind: Literal["absent"]


class FolderSession(TypedDict):
    kind: Literal["folder"]
    entries: dict[str, TreeNode]


type SessionCredentials = AbsentSession | FolderSession


class ExpectedEntry(TypedDict):
    name: str
    cred: CredentialFile


class GoldenCase(TypedDict):
    name: str
    serversFile: ServersFileEnv
    session: SessionCredentials
    env: dict[str, str]
    expected: list[ExpectedEntry]


class GoldenDocument(TypedDict):
    source: str
    cases: list[GoldenCase]


# The golden cases where the Python reader deliberately returns something other than the JavaScript reader, by case
# name, with what Python returns. The JavaScript reader follows a symlink named as the servers file; the Python reader
# opens it with O_NOFOLLOW and refuses it. Every name must exist in the corpus and its JavaScript answer must differ.
DIVERGENT_CASES: dict[str, list[ExpectedEntry]] = {
    "a symlink to a valid file is followed": [],
}

# The golden cases where the Python reader writes its one refusal line on stderr, by case name, with the reason class.
# Every other case writes nothing. A directory and a dangling symlink are no servers in both readers; Python also says
# why. Every name must exist in the corpus.
REFUSED_CASES: dict[str, RefusalReason] = {
    "a symlink to a valid file is followed": "link",
    "a dangling symlink is no servers": "link",
    "a path that is a directory is no servers": "not-regular",
}


def refusal_line(reason: RefusalReason) -> str:
    return f"servers file refused: {reason}\n"


def python_expected(case: GoldenCase) -> list[ExpectedEntry]:
    return DIVERGENT_CASES.get(case["name"], case["expected"])


def expected_stderr(case: GoldenCase) -> str:
    reason = REFUSED_CASES.get(case["name"])
    return "" if reason is None else refusal_line(reason)


class GoldenCorpusMissing(AssertionError):
    """The corpus is absent, empty or smaller than its floor: a test failure, never a skip."""


def load_cases(case_set: str) -> list[GoldenCase]:
    path = GOLDEN / f"{case_set}.json"
    if not path.is_file():
        raise GoldenCorpusMissing(f"golden corpus file missing: {path} (run the vitest generator first)")
    with open(path, encoding="utf-8") as handle:
        document: GoldenDocument = json.load(handle)
    cases = document["cases"]
    if len(cases) < MIN_CASES[case_set]:
        raise GoldenCorpusMissing(f"{path} holds {len(cases)} cases, fewer than its floor of {MIN_CASES[case_set]}")
    return cases


def all_cases() -> list[tuple[str, GoldenCase]]:
    return [(case_set, case) for case_set in CASE_SETS for case in load_cases(case_set)]


def content_bytes(content: Content) -> bytes:
    match content["kind"]:
        case "text":
            return content["text"].encode("utf-8")
        case "bytes":
            return base64.b64decode(content["base64"], validate=True)


def write_content(path: str, content: Content) -> None:
    with open(path, "wb") as handle:
        handle.write(content_bytes(content))


def place(path: str, node: TreeNode, targets: str) -> None:
    match node["kind"]:
        case "text" | "bytes":
            write_content(path, node)
        case "directory":
            os.mkdir(path)
        case "symlink":
            target = os.path.join(tempfile.mkdtemp(prefix="t-", dir=targets), "target")
            write_content(target, node["target"])
            os.symlink(target, path)
        case "dangling-symlink":
            os.symlink(os.path.join(targets, "absent-target"), path)


def lay_out(case: GoldenCase, root: str) -> tuple[str, dict[str, str]]:
    """Build the case's tree under ``root`` as the JavaScript generator does; return the session path and the env.

    A relative servers-file value is made relative to the session directory, the working directory the case runs in,
    so it names the planted file exactly as the generator's value named it from its own working directory.
    """
    targets = os.path.join(root, "targets")
    session = os.path.join(root, "session")
    os.mkdir(targets)
    os.mkdir(session)
    sc = case["session"]
    match sc["kind"]:
        case "absent":
            pass
        case "folder":
            credentials = os.path.join(session, ".guuey", "credentials")
            os.makedirs(credentials)
            for file_name, node in sc["entries"].items():
                place(os.path.join(credentials, file_name), node, targets)
    env = dict(case["env"])
    control = os.path.join(root, "control")
    sf = case["serversFile"]
    match sf["kind"]:
        case "empty":
            env[MCP_SERVERS_FILE_ENV] = ""
        case "file" | "file-trailing-slash":
            os.mkdir(control)
            path = os.path.join(control, "mcp-servers.json")
            place(path, sf["node"], targets)
            env[MCP_SERVERS_FILE_ENV] = path if sf["kind"] == "file" else f"{path}/"
        case "missing":
            env[MCP_SERVERS_FILE_ENV] = os.path.join(root, "absent", "mcp-servers.json")
        case "relative-to-session-file":
            planted = os.path.join(session, "planted-servers.json")
            write_content(planted, sf["content"])
            env[MCP_SERVERS_FILE_ENV] = os.path.relpath(planted, session)
        case "literal":
            env[MCP_SERVERS_FILE_ENV] = sf["value"]
    return session, env


def as_expected(entries: list[CredentialEntry]) -> list[ExpectedEntry]:
    return [{"name": entry.name, "cred": entry.cred} for entry in entries]


@contextlib.contextmanager
def laid_out(case: GoldenCase) -> Iterator[tuple[str, dict[str, str]]]:
    """The case's tree in a fresh temp directory, with the working directory inside its session tree."""
    with tempfile.TemporaryDirectory(prefix="guuey-creds-golden-") as root:
        session, env = lay_out(case, root)
        with contextlib.chdir(session):
            yield session, env


@dataclass(frozen=True, slots=True)
class CaseRun:
    result: list[ExpectedEntry]
    stderr: str


def read_capturing_stderr(env: Mapping[str, str] | None) -> CaseRun:
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        result = as_expected(list_credentials(env)())
    return CaseRun(result=result, stderr=captured.getvalue())


def run_case(case: GoldenCase, extra_env: Mapping[str, str] | None = None) -> CaseRun:
    with laid_out(case) as (_session, env):
        if extra_env is not None:
            env.update(extra_env)
        return read_capturing_stderr(env)


class GoldenReplay(unittest.TestCase):
    """Every recorded case returns what the JavaScript reader returned, except the named divergent cases."""

    def test_corpus_is_present(self) -> None:
        self.assertTrue(GOLDEN.is_dir(), f"golden corpus directory missing: {GOLDEN}")
        for case_set in CASE_SETS:
            self.assertGreaterEqual(len(load_cases(case_set)), MIN_CASES[case_set], case_set)

    def test_servers_file(self) -> None:
        for case in load_cases("servers-file"):
            with self.subTest(case=case["name"]):
                run = run_case(case)
                self.assertEqual(run.result, python_expected(case))
                self.assertEqual(run.stderr, expected_stderr(case))

    def test_every_divergent_case_exists_and_really_diverges(self) -> None:
        by_name = {case["name"]: case for _case_set, case in all_cases()}
        for name, python_value in DIVERGENT_CASES.items():
            with self.subTest(case=name):
                self.assertIn(name, by_name, "a divergent case is missing from the golden corpus (renamed?)")
                self.assertNotEqual(by_name[name]["expected"], python_value, "the JavaScript answer no longer differs")

    def test_every_refused_case_exists(self) -> None:
        names = {case["name"] for _case_set, case in all_cases()}
        for name in REFUSED_CASES:
            with self.subTest(case=name):
                self.assertIn(name, names, "a refused case is missing from the golden corpus (renamed?)")


# The environment variables a legacy credentials path read, or that a reader might reach for, each set to a canary:
# - the retired legacy env lane: the model-key slots a builder worker read from its environment, the other credential
#   slots the platform refuses to pass, and the lane marker;
# - the MCP-named variables used elsewhere in the open packages (the CLI's endpoint and server, a template's socket).
# None of them may ever reach a result. The only variable the reader may consult is MCP_SERVERS_FILE_ENV, for a PATH.
LEGACY_ENV_NAMES = (
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_API_KEY",
    "GUUEY_BUILDER_KEY_LANE",
    "GUUEY_MCP_URL",
    "GUUEY_MCP_SERVER",
    "GUUEY_MCP_SOCKET",
)
CANARY = "legacy-canary-3494-never-read"
CANARY_ENV = {name: f"https://{CANARY}.invalid/{name.lower()}" for name in LEGACY_ENV_NAMES}
CANARY_CREDENTIAL = json.dumps(
    {"url": f"https://{CANARY}.invalid/mcp", "transport": "http", "headers": {"authorization": f"Bearer {CANARY}"}}
)


def with_planted_session(case: GoldenCase) -> GoldenCase:
    """The case with valid canary credentials planted in its session folder (the legacy per-session arm)."""
    planted = copy.deepcopy(case)
    canary: TextContent = {"kind": "text", "text": CANARY_CREDENTIAL}
    sc = planted["session"]
    match sc["kind"]:
        case "folder":
            sc["entries"]["ggui.json"] = canary
            sc["entries"]["zz-canary.json"] = canary
        case "absent":
            planted["session"] = {"kind": "folder", "entries": {"ggui.json": canary, "zz-canary.json": canary}}
    return planted


class NoLegacyEnvFallback(unittest.TestCase):
    """No input, of any shape, makes the reader fall back to a legacy credentials source.

    Kills the mutant "a creds.py that, when the servers file is missing or unreadable, reads the legacy env var", for
    example this one-line change to the return in list_credentials's read():

        return [] if servers_file is None else (_read_servers_file(servers_file) or [CredentialEntry(k, {"url": v, "transport": "http", "headers": {}}) for k, v in os.environ.items() if k.startswith(("ANTHROPIC_", "OPENAI_", "GEMINI_", "GOOGLE_", "GUUEY_MCP_"))])

    and its session-folder twin, which falls back to the working directory's (the session tree's) credentials folder:

        return [] if servers_file is None else (_read_servers_file(servers_file) or [CredentialEntry(f[:-5], _parse(_read_regular_file(os.path.join(os.getcwd(), ".guuey", "credentials", f)))) for f in sorted(os.listdir(os.path.join(".guuey", "credentials"))) if f.endswith(".json")])

    Every golden case where the servers file yields nothing (missing, empty value, refused, malformed, relative)
    then returns a canary entry, and this class goes red.
    """

    def assert_no_canary(self, result: list[ExpectedEntry]) -> None:
        self.assertNotIn(CANARY, json.dumps(result, ensure_ascii=False))

    def test_corpus_holds_no_canary(self) -> None:
        for case_set in CASE_SETS:
            self.assertNotIn(CANARY, (GOLDEN / f"{case_set}.json").read_text(encoding="utf-8"))

    def test_canary_env_never_reaches_a_result(self) -> None:
        """Every case, with every legacy variable set in the given env AND in os.environ: the same answer."""
        with mock.patch.dict(os.environ, CANARY_ENV):
            for case_set, case in all_cases():
                with self.subTest(case_set=case_set, case=case["name"]):
                    run = run_case(case, CANARY_ENV)
                    self.assert_no_canary(run.result)
                    self.assertEqual(run.result, python_expected(case))
                    self.assertEqual(run.stderr, expected_stderr(case))

    def test_canary_env_never_reaches_a_result_through_the_default_env(self) -> None:
        """The same, with env=None: the reader takes the servers-file path from os.environ and nothing else."""
        for case_set, case in all_cases():
            with self.subTest(case_set=case_set, case=case["name"]):
                with laid_out(case) as (_session, env):
                    clean = {k: v for k, v in os.environ.items() if k != MCP_SERVERS_FILE_ENV and k not in CANARY_ENV}
                    with mock.patch.dict(os.environ, {**clean, **CANARY_ENV, **env}, clear=True):
                        run = read_capturing_stderr(None)
                self.assert_no_canary(run.result)
                self.assertEqual(run.result, python_expected(case))
                self.assertEqual(run.stderr, expected_stderr(case))

    def test_planted_session_folder_is_never_read_while_the_variable_is_set(self) -> None:
        """Every case, with valid canary credentials planted in the session folder the case runs inside."""
        for case_set, case in all_cases():
            with self.subTest(case_set=case_set, case=case["name"]):
                run = run_case(with_planted_session(case), CANARY_ENV)
                self.assert_no_canary(run.result)
                self.assertEqual(run.result, python_expected(case))
                self.assertEqual(run.stderr, expected_stderr(case))


@contextlib.contextmanager
def recorded_fs_calls() -> Iterator[dict[str, mock.MagicMock]]:
    """Every way to open, list or probe a path, wrapped so each call is recorded and still performed."""
    targets = ("builtins.open", "os.open", "os.fstat", "os.listdir", "os.scandir", "os.stat", "os.lstat", "os.access")
    with contextlib.ExitStack() as stack:
        recorders: dict[str, mock.MagicMock] = {}
        for target in targets:
            module_name, attribute = target.rsplit(".", 1)
            real = getattr(__import__(module_name), attribute)
            recorders[target] = stack.enter_context(mock.patch(target, wraps=real))
        yield recorders


GOOD = {"url": "https://relay.example/_executor/mcp/abc", "transport": "http", "headers": {"authorization": "Bearer cap"}}
GOOD_DOCUMENT = json.dumps({"version": 1, "servers": [{"name": "ggui", "credential": GOOD}]})


class NoLegacySessionFolder(unittest.TestCase):
    """With the variable UNSET the reader returns no servers and touches no file, the session folder included.

    The JavaScript reader reads the session folder here (an arm it keeps for older supervisors); the Python host has
    no older supervisor and deliberately does not. Kills the mutant "a creds.py that reads the session folder when the
    variable is unset", for example this one-line change to the return in list_credentials's read() (a worker's
    working directory is its session tree):

        return [CredentialEntry(f[:-5], _parse(_read_regular_file(os.path.join(os.getcwd(), ".guuey", "credentials", f)))) for f in sorted(os.listdir(os.path.join(".guuey", "credentials"))) if f.endswith(".json")] if servers_file is None else _read_servers_file(servers_file)

    It then returns the planted canary entries and records a listdir and opens, and this class goes red.
    """

    def assert_reads_nothing(self, calls: dict[str, mock.MagicMock], session: str) -> None:
        for target, recorder in calls.items():
            self.assertEqual(recorder.call_count, 0, f"{target} was called: {recorder.call_args_list}")
        touched = [str(c.args[0]) for recorder in calls.values() for c in recorder.call_args_list if c.args]
        self.assertFalse([p for p in touched if p.startswith(session) or not p.startswith("/")], touched)

    def test_unset_reads_no_session_folder_for_any_case(self) -> None:
        """Every golden case's tree, valid credentials planted in its session folder, the variable removed."""
        for case_set, case in all_cases():
            with self.subTest(case_set=case_set, case=case["name"]):
                with laid_out(with_planted_session(case)) as (session, env):
                    env.pop(MCP_SERVERS_FILE_ENV, None)
                    env.update(CANARY_ENV)
                    read = list_credentials(env)
                    with recorded_fs_calls() as calls:
                        result = read()
                    self.assertEqual(result, [])
                    self.assert_reads_nothing(calls, session)

    def test_unset_reads_no_session_folder_through_the_default_env(self) -> None:
        case: GoldenCase = {
            "name": "unset, default env",
            "serversFile": {"kind": "empty"},
            "session": {"kind": "absent"},
            "env": {},
            "expected": [],
        }
        with laid_out(with_planted_session(case)) as (session, _env):
            clean = {k: v for k, v in os.environ.items() if k != MCP_SERVERS_FILE_ENV}
            with mock.patch.dict(os.environ, {**clean, **CANARY_ENV}, clear=True):
                read = list_credentials()
                with recorded_fs_calls() as calls:
                    result = read()
            self.assertEqual(result, [])
            self.assert_reads_nothing(calls, session)

    def test_the_recorder_sees_the_readers_one_open(self) -> None:
        """Control: with the variable set, the same recorder sees one os.open of the servers file and one fstat."""
        with tempfile.TemporaryDirectory(prefix="guuey-creds-") as root:
            path = os.path.join(root, "mcp-servers.json")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(GOOD_DOCUMENT)
            read = list_credentials({MCP_SERVERS_FILE_ENV: path})
            with recorded_fs_calls() as calls:
                result = read()
        self.assertEqual(as_expected(result), [{"name": "ggui", "cred": GOOD}])
        self.assertEqual([c.args[0] for c in calls["os.open"].call_args_list], [path])
        self.assertEqual(calls["os.fstat"].call_count, 1)
        for target in ("builtins.open", "os.listdir", "os.scandir", "os.stat", "os.lstat", "os.access"):
            self.assertEqual(calls[target].call_count, 0, target)

    def test_the_reader_takes_no_session_path(self) -> None:
        self.assertEqual(list(inspect.signature(list_credentials).parameters), ["env"])


class ReaderBehaviour(unittest.TestCase):
    """What a static corpus cannot hold: re-reads, the default env, and the regular-file, no-follow, read-once rule."""

    def setUp(self) -> None:
        self._root = tempfile.TemporaryDirectory(prefix="guuey-creds-")
        self.root = self._root.name

    def tearDown(self) -> None:
        self._root.cleanup()

    def control_dir(self) -> str:
        return tempfile.mkdtemp(prefix="control-", dir=self.root)

    def servers_file(self, document: str) -> str:
        path = os.path.join(self.control_dir(), "mcp-servers.json")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(document)
        return path

    def read(self, path: str) -> CaseRun:
        return read_capturing_stderr({MCP_SERVERS_FILE_ENV: path})

    def test_a_valid_regular_file_gives_its_entries(self) -> None:
        run = self.read(self.servers_file(GOOD_DOCUMENT))
        self.assertEqual(run.result, [{"name": "ggui", "cred": GOOD}])
        self.assertEqual(run.stderr, "")

    def test_a_symlink_to_a_valid_file_is_refused(self) -> None:
        target = self.servers_file(GOOD_DOCUMENT)
        link = os.path.join(self.control_dir(), "mcp-servers.json")
        os.symlink(target, link)
        run = self.read(link)
        self.assertEqual(run.result, [])
        self.assertEqual(run.stderr, refusal_line("link"))

    def test_a_dangling_symlink_is_refused_as_a_link(self) -> None:
        link = os.path.join(self.control_dir(), "mcp-servers.json")
        os.symlink(os.path.join(self.root, "absent"), link)
        run = self.read(link)
        self.assertEqual(run.result, [])
        self.assertEqual(run.stderr, refusal_line("link"))

    def test_a_directory_is_refused_as_not_regular(self) -> None:
        run = self.read(self.control_dir())
        self.assertEqual(run.result, [])
        self.assertEqual(run.stderr, refusal_line("not-regular"))

    def test_a_device_is_refused_as_not_regular(self) -> None:
        run = self.read(os.devnull)
        self.assertEqual(run.result, [])
        self.assertEqual(run.stderr, refusal_line("not-regular"))

    def test_a_missing_file_is_no_servers_without_a_refusal_line(self) -> None:
        run = self.read(os.path.join(self.root, "absent", "mcp-servers.json"))
        self.assertEqual(run.result, [])
        self.assertEqual(run.stderr, "")

    def test_a_fifo_with_data_waiting_is_refused_and_not_read(self) -> None:
        """The test holds both ends of a FIFO with a credential document in it; the reader must leave every byte."""
        fifo = os.path.join(self.control_dir(), "mcp-servers.json")
        os.mkfifo(fifo)
        payload = GOOD_DOCUMENT.encode("utf-8")
        held_reader = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
        try:
            writer = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
            try:
                self.assertEqual(os.write(writer, payload), len(payload))
                run = self.read(fifo)
                self.assertEqual(run.result, [])
                self.assertEqual(run.stderr, refusal_line("not-regular"))
                self.assertEqual(os.read(held_reader, len(payload) + 1), payload)
            finally:
                os.close(writer)
        finally:
            os.close(held_reader)

    def test_a_fifo_with_no_writer_is_refused_without_waiting(self) -> None:
        """A blocking open of a FIFO waits for a writer forever; the reader must refuse it at once."""
        fifo = os.path.join(self.control_dir(), "mcp-servers.json")
        os.mkfifo(fifo)
        runs: list[CaseRun] = []
        reader = threading.Thread(target=lambda: runs.append(self.read(fifo)), daemon=True)
        reader.start()
        reader.join(timeout=10)
        self.assertFalse(reader.is_alive(), "the reader blocked opening a FIFO")
        self.assertEqual(runs[0].result, [])
        self.assertEqual(runs[0].stderr, refusal_line("not-regular"))

    def test_the_servers_file_is_read_afresh_on_every_call(self) -> None:
        path = self.servers_file(GOOD_DOCUMENT)
        read = list_credentials({MCP_SERVERS_FILE_ENV: path})
        self.assertEqual([entry.name for entry in read()], ["ggui"])
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "servers": [{"name": "next", "credential": GOOD}]}, handle)
        self.assertEqual([entry.name for entry in read()], ["next"])

    def test_the_variable_is_read_on_every_call(self) -> None:
        env: dict[str, str] = {}
        read = list_credentials(env)
        self.assertEqual(read(), [])
        env[MCP_SERVERS_FILE_ENV] = self.servers_file(GOOD_DOCUMENT)
        self.assertEqual([entry.name for entry in read()], ["ggui"])
        del env[MCP_SERVERS_FILE_ENV]
        self.assertEqual(read(), [])

    def test_defaults_to_os_environ(self) -> None:
        path = self.servers_file(GOOD_DOCUMENT)
        with mock.patch.dict(os.environ, {MCP_SERVERS_FILE_ENV: path}):
            self.assertEqual([entry.name for entry in list_credentials()()], ["ggui"])

    def test_deep_nesting_is_no_servers_and_never_raises(self) -> None:
        run = self.read(self.servers_file("[" * 200_000 + "]" * 200_000))
        self.assertEqual(run.result, [])
        self.assertEqual(run.stderr, "")

    def test_opens_once_no_follow_then_fstat_and_never_probes_first(self) -> None:
        source = CREDS_SOURCE.read_text(encoding="utf-8")
        # One open, and it is os.open (every "open(" in the module is that one).
        self.assertEqual(source.count("os.open("), 1)
        self.assertEqual(source.count("open("), 1)
        self.assertIn("O_NOFOLLOW", source)
        self.assertEqual(source.count("os.fstat("), 1)
        self.assertLess(source.index("os.open("), source.index("os.fstat("))
        self.assertIn("S_ISREG(", source)
        for probe in ("os.stat(", "lstat(", "exists(", "access(", "isfile(", "isdir(", "islink(", "realpath(", "listdir(", "scandir(", "walk(", "glob(", "getcwd(", "seek("):
            self.assertNotIn(probe, source)
        # The environment is consulted for one name only: the servers file's path.
        self.assertEqual(source.count(".get(MCP_SERVERS_FILE_ENV)"), 1)
        self.assertNotIn("environ[", source)
        self.assertNotIn("getenv", source)


if __name__ == "__main__":
    unittest.main()
