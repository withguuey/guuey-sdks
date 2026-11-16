"""guuey_host.creds against the golden corpus the JavaScript reader wrote, plus the no-legacy-fallback guard.

The corpus (../golden/creds/*.json) is written by src/python-golden/creds.golden.test.ts, which lays each case out in
a temp directory and records what @guuey/worker's listCredentials returned. Here each case is laid out the same way
and guuey_host.creds must return exactly the same entries, in the same order.
"""

import base64
import copy
import json
import os
import tempfile
import threading
import unittest
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict
from unittest import mock

from guuey_host.creds import MCP_SERVERS_FILE_ENV, CredentialEntry, CredentialFile, list_credentials

GOLDEN = Path(__file__).resolve().parent.parent / "golden" / "creds"
# The case count each corpus file must hold at least (the generator writes 49 and 14). A missing directory or file
# raises and an empty or shrunken corpus fails: the replay never passes, or skips, on nothing.
MIN_CASES = {"servers-file": 49, "session-dir": 14}
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


class UnsetEnv(TypedDict):
    kind: Literal["unset"]


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


type ServersFileEnv = UnsetEnv | EmptyEnv | FileEnv | MissingEnv | RelativeEnv | LiteralEnv


class AbsentSession(TypedDict):
    kind: Literal["absent"]


class NotADirectorySession(TypedDict):
    kind: Literal["not-a-directory"]


class FolderSession(TypedDict):
    kind: Literal["folder"]
    entries: dict[str, TreeNode]


type SessionCredentials = AbsentSession | NotADirectorySession | FolderSession


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


@dataclass(frozen=True, slots=True)
class Fs:
    """The worker's three directories, as the protocol's Fs carries them."""

    app: str
    home: str
    session: str


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


def lay_out(case: GoldenCase, root: str) -> tuple[Fs, dict[str, str]]:
    """Build the case's tree under ``root`` exactly as the JavaScript generator does; return the Fs and env."""
    targets = os.path.join(root, "targets")
    session = os.path.join(root, "session")
    os.mkdir(targets)
    os.mkdir(session)
    credentials = os.path.join(session, ".guuey", "credentials")
    sc = case["session"]
    match sc["kind"]:
        case "absent":
            pass
        case "not-a-directory":
            os.mkdir(os.path.join(session, ".guuey"))
            with open(credentials, "wb"):
                pass
        case "folder":
            os.makedirs(credentials)
            for file_name, node in sc["entries"].items():
                place(os.path.join(credentials, file_name), node, targets)
    env = dict(case["env"])
    control = os.path.join(root, "control")
    sf = case["serversFile"]
    match sf["kind"]:
        case "unset":
            pass
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
            env[MCP_SERVERS_FILE_ENV] = os.path.relpath(planted, os.getcwd())
        case "literal":
            env[MCP_SERVERS_FILE_ENV] = sf["value"]
    return Fs(app=os.path.join(root, "app"), home=os.path.join(root, "home"), session=session), env


def as_expected(entries: list[CredentialEntry]) -> list[ExpectedEntry]:
    return [{"name": entry.name, "cred": entry.cred} for entry in entries]


def run_case(case: GoldenCase, extra_env: Mapping[str, str] | None = None) -> list[ExpectedEntry]:
    with tempfile.TemporaryDirectory(prefix="guuey-creds-golden-") as root:
        fs, env = lay_out(case, root)
        if extra_env is not None:
            env.update(extra_env)
        return as_expected(list_credentials(fs, env)())


class GoldenReplay(unittest.TestCase):
    """Every recorded case returns what the JavaScript reader returned."""

    def test_corpus_is_present(self) -> None:
        self.assertTrue(GOLDEN.is_dir(), f"golden corpus directory missing: {GOLDEN}")
        for case_set in CASE_SETS:
            self.assertGreaterEqual(len(load_cases(case_set)), MIN_CASES[case_set], case_set)

    def test_servers_file(self) -> None:
        for case in load_cases("servers-file"):
            with self.subTest(case=case["name"]):
                self.assertEqual(run_case(case), case["expected"])

    def test_session_dir(self) -> None:
        for case in load_cases("session-dir"):
            with self.subTest(case=case["name"]):
                self.assertEqual(run_case(case), case["expected"])


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
    """The case with a canary credential planted in its session folder (the legacy per-session arm)."""
    planted = copy.deepcopy(case)
    canary: TextContent = {"kind": "text", "text": CANARY_CREDENTIAL}
    sc = planted["session"]
    match sc["kind"]:
        case "folder":
            sc["entries"]["zz-canary.json"] = canary
        case "absent":
            planted["session"] = {"kind": "folder", "entries": {"zz-canary.json": canary}}
        case "not-a-directory":
            pass  # the credentials path is a regular file: nothing can be planted inside it.
    return planted


class NoLegacyEnvFallback(unittest.TestCase):
    """No input, of any shape, makes the reader fall back to a legacy credentials source.

    Kills the mutant "a creds.py that, when the servers file is missing or unreadable, reads the legacy env var", for
    example this one-line change to the return in list_credentials's read():

        return _read_session_dir(fs.session) if servers_file is None else (_read_servers_file(servers_file) or [CredentialEntry(k, {"url": v, "transport": "http", "headers": {}}) for k, v in os.environ.items() if k.startswith(("ANTHROPIC_", "OPENAI_", "GEMINI_", "GOOGLE_", "GUUEY_MCP_"))])

    and its session-folder twin (the legacy per-session arm):

        return _read_session_dir(fs.session) if servers_file is None else (_read_servers_file(servers_file) or _read_session_dir(fs.session))

    Every golden case where the servers file yields nothing (missing, empty value, unreadable, malformed, relative)
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
                    result = run_case(case, CANARY_ENV)
                    self.assert_no_canary(result)
                    self.assertEqual(result, case["expected"])

    def test_canary_env_never_reaches_a_result_through_the_default_env(self) -> None:
        """The same, with env=None: the reader takes the servers-file path from os.environ and nothing else."""
        for case_set, case in all_cases():
            with self.subTest(case_set=case_set, case=case["name"]):
                with tempfile.TemporaryDirectory(prefix="guuey-creds-golden-") as root:
                    fs, env = lay_out(case, root)
                    clean = {k: v for k, v in os.environ.items() if k != MCP_SERVERS_FILE_ENV and k not in CANARY_ENV}
                    with mock.patch.dict(os.environ, {**clean, **CANARY_ENV, **env}, clear=True):
                        result = as_expected(list_credentials(fs)())
                self.assert_no_canary(result)
                self.assertEqual(result, case["expected"])

    def test_planted_session_folder_is_never_read_while_the_variable_is_set(self) -> None:
        """Every case whose variable is set, with a canary credential planted in the session folder."""
        checked = 0
        for case_set, case in all_cases():
            if case["serversFile"]["kind"] == "unset":
                continue
            with self.subTest(case_set=case_set, case=case["name"]):
                result = run_case(with_planted_session(case), CANARY_ENV)
                self.assert_no_canary(result)
                self.assertEqual(result, case["expected"])
                checked += 1
        self.assertGreater(checked, 0)


GOOD = {"url": "https://relay.example/_executor/mcp/abc", "transport": "http", "headers": {"authorization": "Bearer cap"}}


class ReaderBehaviour(unittest.TestCase):
    """The creds.test.ts behaviours a static corpus cannot hold."""

    def setUp(self) -> None:
        self._root = tempfile.TemporaryDirectory(prefix="guuey-creds-")
        self.root = self._root.name

    def tearDown(self) -> None:
        self._root.cleanup()

    def servers_file(self, document: str) -> str:
        path = os.path.join(tempfile.mkdtemp(prefix="control-", dir=self.root), "mcp-servers.json")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(document)
        return path

    def test_the_session_folder_is_read_afresh_on_every_call(self) -> None:
        session = tempfile.mkdtemp(prefix="session-", dir=self.root)
        read = list_credentials(Fs(app="", home="", session=session), {})
        self.assertEqual(read(), [])
        folder = os.path.join(session, ".guuey", "credentials")
        os.makedirs(folder)
        with open(os.path.join(folder, "ggui.json"), "w", encoding="utf-8") as handle:
            json.dump(GOOD, handle)
        self.assertEqual([entry.name for entry in read()], ["ggui"])

    def test_the_variable_is_read_on_every_call(self) -> None:
        session = tempfile.mkdtemp(prefix="session-", dir=self.root)
        env: dict[str, str] = {}
        read = list_credentials(Fs(app="", home="", session=session), env)
        self.assertEqual(read(), [])
        env[MCP_SERVERS_FILE_ENV] = self.servers_file(json.dumps({"version": 1, "servers": [{"name": "ggui", "credential": GOOD}]}))
        self.assertEqual([entry.name for entry in read()], ["ggui"])

    def test_defaults_to_os_environ(self) -> None:
        session = tempfile.mkdtemp(prefix="session-", dir=self.root)
        path = self.servers_file(json.dumps({"version": 1, "servers": [{"name": "ggui", "credential": GOOD}]}))
        with mock.patch.dict(os.environ, {MCP_SERVERS_FILE_ENV: path}):
            self.assertEqual([entry.name for entry in list_credentials(Fs(app="", home="", session=session))()], ["ggui"])

    def test_deep_nesting_is_no_servers_and_never_raises(self) -> None:
        session = tempfile.mkdtemp(prefix="session-", dir=self.root)
        path = self.servers_file("[" * 200_000 + "]" * 200_000)
        self.assertEqual(list_credentials(Fs(app="", home="", session=session), {MCP_SERVERS_FILE_ENV: path})(), [])

    def test_a_servers_file_that_is_a_pipe_is_read_once(self) -> None:
        """A FIFO written once: a second open of the drained pipe would block, so the read must finish alone."""
        fifo = os.path.join(tempfile.mkdtemp(prefix="control-", dir=self.root), "mcp-servers.json")
        os.mkfifo(fifo)
        payload = json.dumps({"version": 1, "servers": [{"name": "ggui", "credential": GOOD}]}).encode("utf-8")

        def write_once() -> None:
            with open(fifo, "wb") as handle:
                handle.write(payload)

        session = tempfile.mkdtemp(prefix="session-", dir=self.root)
        results: list[list[CredentialEntry]] = []
        writer = threading.Thread(target=write_once, daemon=True)
        reader = threading.Thread(
            target=lambda: results.append(list_credentials(Fs(app="", home="", session=session), {MCP_SERVERS_FILE_ENV: fifo})()),
            daemon=True,
        )
        writer.start()
        reader.start()
        reader.join(timeout=10)
        self.assertFalse(reader.is_alive(), "the reader blocked: it opened the pipe more than once")
        self.assertEqual(as_expected(results[0]), [{"name": "ggui", "cred": GOOD}])

    def test_reads_with_one_open_and_never_stats_or_probes(self) -> None:
        source = CREDS_SOURCE.read_text(encoding="utf-8")
        self.assertEqual(source.count("open("), 1)
        for probe in ("stat(", "lstat(", "exists(", "access(", "isfile(", "isdir(", "islink(", "realpath(", "O_NOFOLLOW", "seek("):
            self.assertNotIn(probe, source)
        # The environment is consulted for one name only: the servers file's path.
        self.assertEqual(source.count(".get(MCP_SERVERS_FILE_ENV)"), 1)
        self.assertNotIn("environ[", source)
        self.assertNotIn("getenv", source)


if __name__ == "__main__":
    unittest.main()
