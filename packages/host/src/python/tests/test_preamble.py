"""guuey_host.preamble against the golden corpus the JavaScript writes (guuey#3494, Python host P2).

Every JSON file under ../golden/preamble/ is written by src/python-golden/preamble.golden.test.ts from the REAL
preamble.ts builders: a list of {name, input, expected}. Each case must come out of the Python builder EXACTLY.
A case-set file with no runner here, or a runner with no file, fails: the corpus and this test move together.

Run from oss/packages/host/src/python:  python3 -m unittest discover -s tests -t .
"""

import json
import unittest
from collections.abc import Callable
from pathlib import Path

from guuey_host import preamble

GOLDEN_DIR = Path(__file__).resolve().parent.parent / "golden" / "preamble"


def _load(case_set: str) -> list[dict]:
    """One case set. A missing directory, a missing file or an empty list FAILS, never skips: an absent corpus would
    otherwise pass as zero cases checked."""
    if not GOLDEN_DIR.is_dir():
        raise AssertionError(f"golden directory missing: {GOLDEN_DIR} (run the vitest generator)")
    path = GOLDEN_DIR / f"{case_set}.json"
    if not path.is_file():
        raise AssertionError(f"golden file missing: {path} (run the vitest generator)")
    with path.open(encoding="utf-8") as handle:
        cases = json.load(handle)
    if not isinstance(cases, list) or not cases:
        raise AssertionError(f"{case_set}.json: expected a non-empty list of cases")
    return cases


def _run_constant(name: str) -> str:
    return getattr(preamble, name)


def _run_escape(data: str) -> str:
    return preamble.escape_turn_data(data)


def _run_section(call: dict) -> str | bool:
    """One renderer call; an absent key is JavaScript's undefined, which these renderers read as None."""
    match call["fn"]:
        case "renderUserMemoryRecall":
            return preamble.render_user_memory_recall(call["userMemory"])
        case "renderProfileRecall":
            return preamble.render_profile_recall(call["sections"])
        case "renderResourcesSection":
            return preamble.render_resources_section(call["count"], call["appDir"])
        case "renderMcpAvailabilitySection":
            return preamble.render_mcp_availability_section(call.get("availability"))
        case "renderFirstImpressionSection":
            return preamble.render_first_impression_section(call.get("fi"))
        case "renderFirstImpressionShownSection":
            return preamble.render_first_impression_shown_section(call.get("shown"))
        case "renderSurfaceSection":
            return preamble.render_surface_section(call.get("surfaceHints"))
        case "renderGenerativeUiSection":
            return preamble.render_generative_ui_section(call.get("gguiAttached"), call.get("surfaceHints"))
        case "drawsGuueyA2ui":
            return preamble.draws_guuey_a2ui(call.get("catalogs"), call.get("surfaceHints"))
        case unknown:
            raise AssertionError(f"sections.json names a renderer this test does not run: {unknown}")


def _run_system_prompt(case_input: dict) -> str:
    return preamble.build_system_prompt(case_input["agentPrompt"], case_input["cls"])


def _run_prompt_class(case_input: dict) -> dict:
    return dict(preamble.prompt_class_of(case_input["turn"], case_input["agent"]))


def _run_turn_context(case_input: dict) -> list[str]:
    return preamble.build_turn_context_blocks(case_input["turn"], case_input["cls"])


RUNNERS: dict[str, Callable] = {
    "constants": _run_constant,
    "escape": _run_escape,
    "sections": _run_section,
    "system-prompt": _run_system_prompt,
    "prompt-class": _run_prompt_class,
    "turn-context": _run_turn_context,
}


# The case count each set had when the generator was written: a floor, so a generator edit that silently drops cases
# (or a truncated file) fails here. Raise a floor when cases are added; never lower one without removing the cases on
# purpose.
MIN_CASES: dict[str, int] = {
    "constants": 17,
    "escape": 65,
    "sections": 55,
    "system-prompt": 62,
    "prompt-class": 24,
    "turn-context": 67,
}


class GoldenCorpusTest(unittest.TestCase):
    maxDiff = None

    def test_the_golden_directory_exists(self) -> None:
        self.assertTrue(GOLDEN_DIR.is_dir(), f"golden directory missing: {GOLDEN_DIR} (run the vitest generator)")

    def test_every_case_set_has_a_runner_and_every_runner_a_case_set(self) -> None:
        self.assertEqual(sorted(RUNNERS), sorted(MIN_CASES))
        on_disk = sorted(path.stem for path in GOLDEN_DIR.glob("*.json"))
        self.assertEqual(on_disk, sorted(RUNNERS))

    def test_every_case_set_meets_its_minimum_case_count(self) -> None:
        for case_set, minimum in MIN_CASES.items():
            with self.subTest(case_set=case_set):
                self.assertGreaterEqual(len(_load(case_set)), minimum)

    def test_every_golden_case_is_byte_identical(self) -> None:
        checked = 0
        for case_set, run in RUNNERS.items():
            for case in _load(case_set):
                checked += 1
                with self.subTest(case_set=case_set, case=case["name"]):
                    self.assertEqual(run(case["input"]), case["expected"])
        self.assertGreaterEqual(checked, sum(MIN_CASES.values()))


class JavaScriptSemanticsTest(unittest.TestCase):
    """What json.load cannot hand the builders: Python values that are not already in JavaScript's own form."""

    def _golden(self, case_set: str, name: str) -> dict:
        matches = [case for case in _load(case_set) if case["name"] == name]
        self.assertEqual(len(matches), 1, f"{case_set}.json has no single case named {name!r}")
        return matches[0]

    def test_array_index_keys_lead_whatever_the_python_insertion_order(self) -> None:
        # The golden input was written by JSON.stringify, so its keys are already in JavaScript's order. A Python dict
        # in source order must render identically: array-index keys first, ascending, then the rest as inserted.
        case = self._golden("turn-context", "state: array-index keys reorder")
        turn = {"priorState": {"b": 1, "1": 2, "a": 3, "0": 4}}
        self.assertEqual(preamble.build_turn_context_blocks(turn, case["input"]["cls"]), case["expected"])
        self.assertIn('{\n  "0": 4,\n  "1": 2,\n  "b": 1,\n  "a": 3\n}', case["expected"][0])

    def test_numbers_are_doubles_spelled_as_javascript_spells_them(self) -> None:
        self.assertEqual(preamble._json_stringify(2**53 + 1), "9007199254740992")
        self.assertEqual(preamble._json_stringify(10**400), "null")
        self.assertEqual(preamble._js_number_to_string(10**400), "Infinity")
        self.assertEqual(preamble._json_stringify(-0.0), "0")
        self.assertEqual(preamble._json_stringify(1.0), "1")
        self.assertEqual(preamble._json_stringify([1e-7, 1e21, 1e-6, 1e20]), "[1e-7,1e+21,0.000001,100000000000000000000]")
        self.assertEqual(preamble._json_stringify(float("nan")), "null")

    def test_a_paired_surrogate_is_written_raw_and_a_lone_one_escaped(self) -> None:
        self.assertEqual(preamble._json_stringify("😀"), '"😀"')
        self.assertEqual(preamble._json_stringify("\ude00\ud83d"), '"\\ude00\\ud83d"')

    def test_absent_prior_state_renders_nothing_and_none_renders_null(self) -> None:
        cls = self._golden("turn-context", "state: null")["input"]["cls"]
        self.assertEqual(preamble.build_turn_context_blocks({}, cls)[0], f"<turn_context>\n{preamble.TURN_CONTEXT_LEAD}\n</turn_context>")
        self.assertIn("<working_state>\nnull\n</working_state>", preamble.build_turn_context_blocks({"priorState": None}, cls)[0])


if __name__ == "__main__":
    unittest.main()
