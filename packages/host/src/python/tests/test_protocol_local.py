"""The parts of the Python worker-protocol port the golden corpus cannot reach: real descriptors (the line reader over
a pipe, the launch-envelope reader, the fd sink), the async reader, ``Turn``, the stderr note, and spot checks of the
JavaScript JSON codec against values whose JavaScript form is fixed by the ECMAScript spec.

Run from ``oss/packages/host/src/python``: ``python3 -m unittest discover -s tests -t .``
"""

import asyncio
import contextlib
import io
import os
import tempfile
import unittest
from collections.abc import AsyncIterator

from guuey_host.emit import FdSink, Turn, create_emitter
from guuey_host.lines import alines, fd_chunks, lines
from guuey_host.protocol import Fs, Identity
from guuey_host.protocol_json import (
    JsonSyntaxFailure,
    js_json_stringify,
    js_json_try_parse,
    js_trim,
    utf16_prefix,
)
from guuey_host.protocol_launch_envelope import (
    LAUNCH_ENVELOPE_FD_ENV,
    LaunchEnvelope,
    LaunchEnvelopeError,
    LaunchModelCapability,
    read_launch_envelope,
    read_launch_envelope_from,
)
from guuey_host.protocol_rules import CONTEXT_ONLY_TURN_TEXT, model_input_of


def _is_closed(fd: int) -> bool:
    try:
        os.fstat(fd)
    except OSError:
        return True
    return False


class JsJsonTest(unittest.TestCase):
    def test_numbers_print_as_javascript_prints_them(self) -> None:
        cases: list[tuple[float | int, str]] = [
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (-0.0, "0"),
            (2.0, "2"),
            (2**64, "18446744073709552000"),
            (10**400, "null"),
            (float("nan"), "null"),
            (float("inf"), "null"),
            (5e-324, "5e-324"),
            (123e-20, "1.23e-18"),
        ]
        for value, text in cases:
            with self.subTest(text):
                self.assertEqual(js_json_stringify(value), text)

    def test_booleans_are_not_numbers(self) -> None:
        self.assertEqual(js_json_stringify([True, False, 1]), "[true,false,1]")

    def test_refuses_what_json_parse_refuses(self) -> None:
        for text in ["", "NaN", "Infinity", "-Infinity", "[1,]", "{'a':1}", "01", "﻿1", "1 2"]:
            with self.subTest(text):
                self.assertIsInstance(js_json_try_parse(text), JsonSyntaxFailure)

    def test_parsed_numbers_are_javascript_doubles(self) -> None:
        self.assertEqual(js_json_try_parse("[2.0,9007199254740993,1e400]"), [2, 9007199254740992, float("inf")])
        parsed = js_json_try_parse("2.0")
        self.assertIs(type(parsed), int)

    def test_object_keys_take_javascript_order(self) -> None:
        parsed = js_json_try_parse('{"b":1,"10":2,"2":3,"4294967295":4,"01":5}')
        if isinstance(parsed, JsonSyntaxFailure):
            self.fail("the object did not parse")
        self.assertEqual(js_json_stringify(parsed), '{"2":3,"10":2,"b":1,"4294967295":4,"01":5}')
        self.assertEqual(js_json_stringify({"b": 1, "1": 2}), '{"1":2,"b":1}')

    def test_strings_escape_as_json_stringify_does(self) -> None:
        self.assertEqual(js_json_stringify("a\u0001\u007f \ud800\U0001f600"), '"a\\u0001\u007f \\ud800\U0001f600"')


class TextHelpersTest(unittest.TestCase):
    def test_utf16_prefix_counts_code_units(self) -> None:
        self.assertEqual(utf16_prefix("ab", 1), "a")
        self.assertEqual(utf16_prefix("\U0001f600\U0001f600", 2), "\U0001f600")
        self.assertEqual(utf16_prefix("a\U0001f600", 2), "a\ud83d")
        self.assertEqual(utf16_prefix("short", 200), "short")

    def test_js_trim(self) -> None:
        self.assertEqual(js_trim("﻿  x 　 "), "x")
        self.assertEqual(js_trim("\x1cx\x85"), "\x1cx\x85")


class LinesOverDescriptorsTest(unittest.TestCase):
    def test_reads_lines_off_a_pipe(self) -> None:
        read_end, write_end = os.pipe()
        os.write(write_end, '{"type":"shutdown"}\r\n\n  {"type":"x","t":"5 €"}'.encode())
        os.close(write_end)
        try:
            self.assertEqual(
                list(lines(fd_chunks(read_end))),
                ['{"type":"shutdown"}', '{"type":"x","t":"5 €"}'],
            )
        finally:
            os.close(read_end)

    def test_async_lines(self) -> None:
        async def chunks() -> AsyncIterator[bytes | str]:
            yield b"a\n\xe2\x82"
            yield b"\xac\nb"

        async def collect() -> list[str]:
            return [line async for line in alines(chunks())]

        self.assertEqual(asyncio.run(collect()), ["a", "€", "b"])


class FdSinkTest(unittest.TestCase):
    def test_emitter_lines_reach_the_descriptor_as_utf8(self) -> None:
        read_end, write_end = os.pipe()
        try:
            emitter = create_emitter(FdSink(write_end))
            emitter.text("€\ud800")
            emitter.done("ok")
            os.close(write_end)
            data = b"".join(fd_chunks(read_end))
        finally:
            os.close(read_end)
        self.assertEqual(
            data,
            '{"type":"text","text":"€\\ud800"}\n{"type":"done","stopReason":"end_turn","result":"ok"}\n'.encode(),
        )


class TurnTest(unittest.TestCase):
    def test_text_accumulates_and_streams(self) -> None:
        out = io.StringIO()
        seen: list[str] = []
        turn = Turn(
            "hi",
            Identity(user_id="u", auth_mode="anonymous"),
            Fs(app="/app", home="/home", session="/session"),
            (),
            create_emitter(out),
            seen.append,
        )
        turn.text("a")
        turn.text("b")
        self.assertEqual(seen, ["a", "b"])
        self.assertEqual(out.getvalue(), '{"type":"text","text":"a"}\n{"type":"text","text":"b"}\n')


class ModelInputTest(unittest.TestCase):
    def test_a_substitution_is_noted_on_stderr_without_text(self) -> None:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(model_input_of("", "context-only"), CONTEXT_ONLY_TURN_TEXT)
            self.assertEqual(model_input_of("typed"), "typed")
        self.assertEqual(err.getvalue(), "[guuey] input substituted: kind=context-only\n")


class LaunchEnvelopeReaderTest(unittest.TestCase):
    LINE = b'{"v":1,"model":{"wire":"openai","token":"tok"}}\n'

    def _pipe_with(self, payload: bytes, close: bool = True) -> tuple[int, int]:
        read_end, write_end = os.pipe()
        os.write(write_end, payload)
        if close:
            os.close(write_end)
        return read_end, write_end

    def test_reads_closes_and_removes_the_marker(self) -> None:
        read_end, _ = self._pipe_with(self.LINE)
        env = {LAUNCH_ENVELOPE_FD_ENV: "5", "OTHER": "x"}
        envelope = read_launch_envelope_from(read_end, env)
        self.assertEqual(envelope, LaunchEnvelope(model=LaunchModelCapability(wire="openai", token="tok")))
        self.assertTrue(_is_closed(read_end))
        self.assertEqual(env, {"OTHER": "x"})

    def test_an_oversized_payload_is_refused_and_closed(self) -> None:
        read_end, _ = self._pipe_with(self.LINE)
        env = {LAUNCH_ENVELOPE_FD_ENV: "5"}
        with self.assertRaisesRegex(LaunchEnvelopeError, "^launch envelope refused: payload exceeds the size limit$"):
            read_launch_envelope_from(read_end, env, max_bytes=10)
        self.assertTrue(_is_closed(read_end))
        self.assertIn(LAUNCH_ENVELOPE_FD_ENV, env)

    def test_no_eof_within_the_deadline(self) -> None:
        read_end, write_end = self._pipe_with(b'{"v":', close=False)
        try:
            with self.assertRaisesRegex(LaunchEnvelopeError, "^launch envelope refused: no EOF within 50 ms$"):
                read_launch_envelope_from(read_end, {LAUNCH_ENVELOPE_FD_ENV: "5"}, deadline_ms=50)
            self.assertTrue(_is_closed(read_end))
        finally:
            os.close(write_end)

    def test_a_regular_file_is_refused_and_closed(self) -> None:
        with tempfile.TemporaryFile() as handle:
            handle.write(self.LINE)
            handle.flush()
            fd = os.dup(handle.fileno())
            with self.assertRaisesRegex(LaunchEnvelopeError, f"^launch envelope refused: fd {fd} is not a socket or FIFO$"):
                read_launch_envelope_from(fd, {LAUNCH_ENVELOPE_FD_ENV: "5"})
            self.assertTrue(_is_closed(fd))

    def test_a_malformed_payload_never_shows_its_bytes(self) -> None:
        read_end, _ = self._pipe_with(b'{"v":1,"model":{"wire":"openai","token":"se cret"}}\n')
        with self.assertRaises(LaunchEnvelopeError) as raised:
            read_launch_envelope_from(read_end, {LAUNCH_ENVELOPE_FD_ENV: "5"})
        self.assertNotIn("se cret", str(raised.exception))
        self.assertEqual(str(raised.exception), "launch envelope refused: model token is malformed")

    def test_no_marker_means_no_envelope(self) -> None:
        self.assertIsNone(read_launch_envelope({}))

    def test_a_marker_naming_another_descriptor_is_refused(self) -> None:
        with self.assertRaisesRegex(
            LaunchEnvelopeError, "^launch envelope refused: GUUEY_LAUNCH_ENVELOPE_FD must name fd 5$"
        ):
            read_launch_envelope({LAUNCH_ENVELOPE_FD_ENV: "6"})


if __name__ == "__main__":
    unittest.main()
