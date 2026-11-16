"""The Python port of the worker line protocol, held byte for byte to the JavaScript implementation (guuey#3494, P1).

Every JSON file under ``../golden/worker-protocol/`` is written by
``src/python-golden/worker-protocol.golden.test.ts``, which runs each case through ``@guuey/worker``. Each case here
runs through ``guuey_host`` and must give the same outcome: the same returned value AND the same
``JSON.stringify`` bytes for it (key order, number and string forms included), the same written bytes for an
emitter, or the same error name and message for a refusal.

Run from ``oss/packages/host/src/python``: ``python3 -m unittest discover -s tests -t .``
"""

import io
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Final, Protocol, runtime_checkable

from guuey_host.emit import create_emitter, create_suspend_writer
from guuey_host.lines import lines
from guuey_host.parse import _parse_hello_cli_session, _parse_stored_measures, is_invoke, parse_control, read_event
from guuey_host.protocol import (
    ADK_HOST_COMPLETION_CAPABILITY,
    CLI_SESSION_CAPABILITY,
    CLI_SESSION_HASH_VERSION,
    CLI_SESSION_RESUME_FAILED,
    HOST_SUSPEND_CAPABILITY,
    INPUT_KINDS,
    INVOKE_IMAGE_MIME_TYPES,
    INVOKE_IMAGES_CAPABILITY,
    PROTOCOL_VERSION,
    SUSPEND_ENVELOPE_MAX_BYTES,
    TOOL_GATES_CAPABILITY,
    EndThread,
    Invoke,
    StopReason,
    WorkerProtocolError,
)
from guuey_host.protocol_json import JsonObject, JsonSyntaxFailure, JsonValue, js_json_stringify, js_json_try_parse
from guuey_host.protocol_launch_envelope import (
    LAUNCH_ENVELOPE_DEADLINE_MS,
    LAUNCH_ENVELOPE_FD,
    LAUNCH_ENVELOPE_FD_ENV,
    LAUNCH_ENVELOPE_MAX_BYTES,
    LAUNCH_ENVELOPE_VERSION,
    LaunchEnvelope,
    LaunchEnvelopeError,
    LaunchModelCapability,
    encode_launch_envelope,
    is_launch_wire,
    parse_launch_envelope,
)
from guuey_host.protocol_rules import (
    CLIENT_CATALOG_ID_MAX_CHARS,
    CLIENT_CATALOG_ID_PATTERN,
    CLIENT_CATALOGS_MAX,
    CONTEXT_ONLY_TURN_TEXT,
    END_THREAD_CODE_PATTERN,
    END_THREAD_MESSAGE_MAX_CHARS,
    MODEL_TEXT_INPUT_KIND_CAPABILITIES,
    CliSessionRecord,
    compare_stored_session,
    end_thread_problem,
    input_kind_capability,
    invoke_images_capabilities,
    is_input_kind,
    is_invoke_image_mime_type,
    is_standard_base64,
    mcp_tool_custom_data,
    model_text_of,
    parse_client_catalogs,
)

GOLDEN_DIR: Final = Path(__file__).resolve().parent.parent / "golden" / "worker-protocol"


# -- reading the corpus ------------------------------------------------------------------------------------------------


MIN_CASES: Final[dict[str, int]] = {
    "parse-control.json": 193,
    "read-event.json": 89,
    "emit.json": 32,
    "suspend-writer.json": 9,
    "lines.json": 24,
    "launch-envelope.json": 38,
    "end-thread.json": 22,
    "client-catalogs.json": 14,
    "images.json": 20,
    "input-kinds.json": 7,
    "model-text.json": 8,
    "cli-session-compare.json": 10,
    "mcp-custom-data.json": 5,
}
"""The fewest cases each case file may hold: the count the generator writes today. A missing directory, a missing
file, an empty list or a shrunken one FAILS the replay; nothing here ever skips."""

MIN_TOTAL_CASES: Final = 471
"""The fewest cases all case files hold together: the sum the generator writes today."""

MIN_CONSTANTS: Final = 23


def _load(file: str) -> JsonValue:
    if not GOLDEN_DIR.is_dir():
        raise AssertionError(f"{GOLDEN_DIR} is missing: run the golden generator (vitest) first")
    path = GOLDEN_DIR / file
    if not path.is_file():
        raise AssertionError(f"{path} is missing: run the golden generator (vitest) first")
    parsed = js_json_try_parse(path.read_text(encoding="utf-8"))
    if isinstance(parsed, JsonSyntaxFailure):
        raise AssertionError(f"{file} is not JSON")
    return parsed


def _obj(value: JsonValue) -> JsonObject:
    if not isinstance(value, dict):
        raise AssertionError(f"expected a JSON object, got {js_json_stringify(value)[:80]}")
    return value


def _list(value: JsonValue) -> list[JsonValue]:
    if not isinstance(value, list):
        raise AssertionError(f"expected a JSON array, got {js_json_stringify(value)[:80]}")
    return value


def _str(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise AssertionError(f"expected a string, got {js_json_stringify(value)[:80]}")
    return value


def _str_list(value: JsonValue) -> list[str]:
    return [_str(item) for item in _list(value)]


def _optional_obj(case: JsonObject, key: str) -> JsonObject | None:
    return _obj(case[key]) if key in case else None


def _cases(file: str) -> list[JsonObject]:
    cases = [_obj(case) for case in _list(_load(file))]
    minimum = MIN_CASES[file]
    if len(cases) < minimum:
        raise AssertionError(f"{file} holds {len(cases)} cases, fewer than the {minimum} it must hold")
    return cases


# -- outcomes, shaped as the generator shapes them ---------------------------------------------------------------------


@runtime_checkable
class _Wired(Protocol):
    def to_wire(self) -> JsonObject: ...


type _Result = _Wired | str | bool | tuple[str, ...] | list[str] | None


def _as_json(value: _Wired | str | bool | tuple[str, ...] | list[str]) -> JsonValue:
    if isinstance(value, _Wired):
        return value.to_wire()
    if isinstance(value, (tuple, list)):
        items: list[JsonValue] = []
        items.extend(value)
        return items
    return value


def _outcome(call: Callable[[], _Result]) -> JsonObject:
    try:
        value = call()
    except (WorkerProtocolError, LaunchEnvelopeError) as error:
        return {"error": {"name": error.JS_NAME, "message": str(error)}}
    if value is None:
        return {"returned": "undefined"}
    wire = _as_json(value)
    return {"ok": wire, "line": js_json_stringify(wire)}


class _GoldenCase(unittest.TestCase):
    def assert_same(self, got: JsonValue, expected: JsonValue) -> None:
        """Equal as values, then equal as ``JSON.stringify`` bytes (which also pins key order and number forms)."""
        self.assertEqual(got, expected)
        self.assertEqual(js_json_stringify(got), js_json_stringify(expected))


# -- per-file checkers -------------------------------------------------------------------------------------------------


def _invoke_of(line: str) -> Invoke:
    message = parse_control(line)
    if not is_invoke(message):
        raise AssertionError("the case's line is not an invoke")
    return message


def _stop_reason(value: JsonValue) -> StopReason:
    match value:
        case "end_turn":
            return "end_turn"
        case "max_turns":
            return "max_turns"
        case "error":
            return "error"
        case _:
            raise AssertionError(f"not a stop reason: {js_json_stringify(value)}")


def _run_emit(calls: list[JsonValue]) -> str:
    out = io.StringIO()
    emitter = create_emitter(out)
    for raw in calls:
        call = _obj(raw)
        method = _str(call["method"])
        if method == "text":
            emitter.text(_str(call["text"]))
        elif method == "done":
            stop_reason = _stop_reason(call["stopReason"]) if "stopReason" in call else "end_turn"
            end = _optional_obj(call, "endThread")
            end_thread = None if end is None else EndThread(code=_str(end["code"]), message=_str(end["message"]))
            emitter.done(_str(call["result"]), stop_reason, end_thread)
        elif method == "error":
            emitter.error(_str(call["message"]))
        elif method == "native":
            emitter.native(_str(call["framework"]), call["event"])
        elif method == "hello":
            sdk_name, sdk_version = call["sdkName"], call["sdkVersion"]
            if sdk_name is not None:
                sdk_name = _str(sdk_name)
            if sdk_version is not None:
                sdk_version = _str(sdk_version)
            capabilities = _str_list(call["capabilities"]) if "capabilities" in call else None
            cli_session = None
            if "cliSession" in call:
                cli_session = _parse_hello_cli_session(call["cliSession"])
                if cli_session is None:
                    raise AssertionError("the case's cliSession block does not parse")
            emitter.hello(_str(call["framework"]), sdk_name, sdk_version, capabilities, cli_session)
        else:
            raise AssertionError(f"unknown emitter method {method}")
    return out.getvalue()


def _launch_envelope_of(raw: JsonObject) -> LaunchEnvelope:
    model = _optional_obj(raw, "model")
    if model is None:
        return LaunchEnvelope()
    wire = model["wire"]
    if not is_launch_wire(wire):
        raise AssertionError("the case's wire is not a launch wire")
    return LaunchEnvelope(model=LaunchModelCapability(wire=wire, token=_str(model["token"])))


def _js_regexp_source(source: str) -> str:
    # RegExp.prototype.source may escape "/" as "\/"; the pattern itself is the same.
    return source.replace("\\/", "/")


PYTHON_CONSTANTS: Final[dict[str, JsonValue]] = {
    "PROTOCOL_VERSION": PROTOCOL_VERSION,
    "ADK_HOST_COMPLETION_CAPABILITY": ADK_HOST_COMPLETION_CAPABILITY,
    "HOST_SUSPEND_CAPABILITY": HOST_SUSPEND_CAPABILITY,
    "TOOL_GATES_CAPABILITY": TOOL_GATES_CAPABILITY,
    "CLI_SESSION_CAPABILITY": CLI_SESSION_CAPABILITY,
    "CLI_SESSION_HASH_VERSION": CLI_SESSION_HASH_VERSION,
    "CLI_SESSION_RESUME_FAILED": CLI_SESSION_RESUME_FAILED,
    "INVOKE_IMAGES_CAPABILITY": INVOKE_IMAGES_CAPABILITY,
    "INVOKE_IMAGE_MIME_TYPES": list[JsonValue](INVOKE_IMAGE_MIME_TYPES),
    "SUSPEND_ENVELOPE_MAX_BYTES": SUSPEND_ENVELOPE_MAX_BYTES,
    "INPUT_KINDS": list[JsonValue](INPUT_KINDS),
    "CLIENT_CATALOGS_MAX": CLIENT_CATALOGS_MAX,
    "CLIENT_CATALOG_ID_MAX_CHARS": CLIENT_CATALOG_ID_MAX_CHARS,
    "CLIENT_CATALOG_ID_PATTERN": CLIENT_CATALOG_ID_PATTERN.pattern,
    "END_THREAD_CODE_PATTERN": END_THREAD_CODE_PATTERN.pattern,
    "END_THREAD_MESSAGE_MAX_CHARS": END_THREAD_MESSAGE_MAX_CHARS,
    "CONTEXT_ONLY_TURN_TEXT": CONTEXT_ONLY_TURN_TEXT,
    "MODEL_TEXT_INPUT_KIND_CAPABILITIES": list[JsonValue](MODEL_TEXT_INPUT_KIND_CAPABILITIES),
    "LAUNCH_ENVELOPE_FD_ENV": LAUNCH_ENVELOPE_FD_ENV,
    "LAUNCH_ENVELOPE_FD": LAUNCH_ENVELOPE_FD,
    "LAUNCH_ENVELOPE_VERSION": LAUNCH_ENVELOPE_VERSION,
    "LAUNCH_ENVELOPE_MAX_BYTES": LAUNCH_ENVELOPE_MAX_BYTES,
    "LAUNCH_ENVELOPE_DEADLINE_MS": LAUNCH_ENVELOPE_DEADLINE_MS,
}

GOLDEN_FILES: Final = frozenset(
    {
        "parse-control.json",
        "read-event.json",
        "emit.json",
        "suspend-writer.json",
        "lines.json",
        "launch-envelope.json",
        "end-thread.json",
        "client-catalogs.json",
        "images.json",
        "input-kinds.json",
        "model-text.json",
        "cli-session-compare.json",
        "mcp-custom-data.json",
        "constants.json",
    }
)


class GoldenCorpusTest(_GoldenCase):
    def test_every_golden_file_is_checked(self) -> None:
        self.assertTrue(GOLDEN_DIR.is_dir(), f"{GOLDEN_DIR} is missing: run the golden generator (vitest) first")
        self.assertEqual(frozenset(MIN_CASES) | {"constants.json"}, GOLDEN_FILES, "every case file has a minimum count")
        on_disk = frozenset(path.name for path in GOLDEN_DIR.glob("*.json"))
        self.assertEqual(on_disk, GOLDEN_FILES, "a golden file with no checker here, or a checker with no file")

    def test_the_corpus_holds_at_least_its_total(self) -> None:
        self.assertEqual(sum(MIN_CASES.values()), MIN_TOTAL_CASES, "the total floor is the sum of the file floors")
        total = sum(len(_cases(file)) for file in MIN_CASES)
        self.assertGreaterEqual(total, MIN_TOTAL_CASES, "the corpus lost cases")

    def test_parse_control(self) -> None:
        for case in _cases("parse-control.json"):
            with self.subTest(case["name"]):
                line = _str(case["input"])
                self.assert_same(_outcome(lambda: parse_control(line)), case["expected"])

    def test_read_event(self) -> None:
        for case in _cases("read-event.json"):
            with self.subTest(case["name"]):
                line = _str(case["input"])
                self.assert_same(_outcome(lambda: read_event(line)), case["expected"])

    def test_emit(self) -> None:
        for case in _cases("emit.json"):
            with self.subTest(case["name"]):
                self.assertEqual(_run_emit(_list(case["calls"])), _str(case["expected"]))

    def test_suspend_writer(self) -> None:
        for case in _cases("suspend-writer.json"):
            with self.subTest(case["name"]):
                out = io.StringIO()
                writer = create_suspend_writer(out, _invoke_of(_str(case["invoke"])))
                got: JsonObject
                if writer is None:
                    got = {"writer": False}
                else:
                    results: list[JsonValue] = []
                    for raw in _list(case["writes"]):
                        write = _obj(raw)
                        results.append(writer.suspend(_str(write["envelope"]), _str_list(write["askIds"])))
                    got = {
                        "writer": True,
                        "maxEnvelopeBytes": writer.max_envelope_bytes,
                        "results": results,
                        "output": out.getvalue(),
                    }
                self.assert_same(got, case["expected"])

    def test_lines(self) -> None:
        for case in _cases("lines.json"):
            with self.subTest(case["name"]):
                chunks: list[bytes | str] = []
                for raw in _list(case["chunks"]):
                    chunk = _obj(raw)
                    chunks.append(bytes.fromhex(_str(chunk["hex"])) if "hex" in chunk else _str(chunk["text"]))
                self.assertEqual(list(lines(chunks)), _str_list(case["expected"]))

    def test_launch_envelope(self) -> None:
        for case in _cases("launch-envelope.json"):
            with self.subTest(case["name"]):
                op = _str(case["op"])
                if op == "parse":
                    text = _str(case["input"])
                    got = _outcome(lambda: parse_launch_envelope(text))
                elif op == "encode":
                    envelope = _launch_envelope_of(_obj(case["input"]))
                    got = _outcome(lambda: encode_launch_envelope(envelope).decode("utf-8"))
                else:
                    raise AssertionError(f"unknown op {op}")
                self.assert_same(got, case["expected"])

    def test_end_thread(self) -> None:
        for case in _cases("end-thread.json"):
            with self.subTest(case["name"]):
                raw = _obj(case["input"])
                request = EndThread(code=_str(raw["code"]), message=_str(raw["message"]))
                self.assert_same(_outcome(lambda: end_thread_problem(request)), case["expected"])

    def test_client_catalogs(self) -> None:
        for case in _cases("client-catalogs.json"):
            with self.subTest(case["name"]):
                raw = case["input"]
                self.assert_same(_outcome(lambda: parse_client_catalogs(raw)), case["expected"])

    def test_images(self) -> None:
        for case in _cases("images.json"):
            with self.subTest(case["name"]):
                fn, raw = _str(case["fn"]), case["input"]
                if fn == "isStandardBase64":
                    data = _str(raw)
                    got = _outcome(lambda: is_standard_base64(data))
                elif fn == "isInvokeImageMimeType":
                    got = _outcome(lambda: is_invoke_image_mime_type(raw))
                elif fn == "invokeImagesCapabilities":
                    line = _str(raw)
                    got = _outcome(lambda: invoke_images_capabilities(_invoke_of(line)))
                else:
                    raise AssertionError(f"unknown function {fn}")
                self.assert_same(got, case["expected"])

    def test_input_kinds(self) -> None:
        for case in _cases("input-kinds.json"):
            with self.subTest(case["name"]):
                fn, raw = _str(case["fn"]), case["input"]
                if fn == "isInputKind":
                    got = _outcome(lambda: is_input_kind(raw))
                elif fn == "inputKindCapability":
                    if not is_input_kind(raw):
                        raise AssertionError("the case's kind is not an input kind")
                    kind = raw
                    got = _outcome(lambda: input_kind_capability(kind))
                else:
                    raise AssertionError(f"unknown function {fn}")
                self.assert_same(got, case["expected"])

    def test_model_text(self) -> None:
        for case in _cases("model-text.json"):
            with self.subTest(case["name"]):
                turn = _obj(case["input"])
                text = _str(turn["text"])
                kind = None
                if "inputKind" in turn:
                    raw_kind = turn["inputKind"]
                    if not is_input_kind(raw_kind):
                        raise AssertionError("the case's kind is not an input kind")
                    kind = raw_kind
                self.assert_same(_outcome(lambda: model_text_of(text, kind)), case["expected"])

    def test_cli_session_compare(self) -> None:
        for case in _cases("cli-session-compare.json"):
            with self.subTest(case["name"]):
                raw_record = _obj(case["record"])
                record = CliSessionRecord(id=_str(raw_record["id"]), last_prompt_sha=_str(raw_record["lastPromptSha"]))
                stored = _parse_stored_measures(case["stored"])
                if stored is None:
                    raise AssertionError("the case's stored measures do not parse")
                self.assert_same(_outcome(lambda: compare_stored_session(record, stored)), case["expected"])

    def test_mcp_custom_data(self) -> None:
        for case in _cases("mcp-custom-data.json"):
            with self.subTest(case["name"]):
                context = _obj(case["context"])
                structured = _optional_obj(context, "structuredContent")
                meta = _optional_obj(context, "resultMeta")
                self.assert_same(_outcome(lambda: mcp_tool_custom_data(structured, meta)), case["expected"])

    def test_constants(self) -> None:
        expected = _obj(_load("constants.json"))
        self.assertGreaterEqual(len(expected), MIN_CONSTANTS, "constants.json lost entries")
        self.assertEqual(set(expected), set(PYTHON_CONSTANTS), "every JavaScript constant has a Python twin")
        for name, value in expected.items():
            with self.subTest(name):
                if name.endswith("_PATTERN"):
                    self.assertEqual(PYTHON_CONSTANTS[name], _js_regexp_source(_str(value)))
                else:
                    self.assert_same(PYTHON_CONSTANTS[name], value)


if __name__ == "__main__":
    unittest.main()
