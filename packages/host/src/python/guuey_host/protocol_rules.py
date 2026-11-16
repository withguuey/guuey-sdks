"""The protocol's small rules, each kept in one place as in ``@guuey/worker``.

Ports of ``input-kinds.ts``, ``images.ts`` (the image check, not the image store), ``client-catalogs.ts``,
``end-thread.ts``, ``model-text.ts``, ``cli-session-compare.ts`` and ``mcp-custom-data.ts``. Every regular expression
keeps its JavaScript source and is applied with ``fullmatch``: Python's ``$`` also matches before a trailing newline,
JavaScript's does not.
"""

import re
import sys
from dataclasses import dataclass
from typing import Final, Literal, TypeIs

from guuey_host.protocol import (
    INPUT_KINDS,
    INVOKE_IMAGE_MIME_TYPES,
    INVOKE_IMAGES_CAPABILITY,
    EndThread,
    HelloStoredMeasures,
    InputKind,
    Invoke,
    InvokeImageMimeType,
)
from guuey_host.protocol_json import JsonObject, JsonValue, js_trim

# -- input-kinds.ts ----------------------------------------------------------------------------------------------------


def is_input_kind(value: JsonValue) -> TypeIs[InputKind]:
    """Whether ``value`` is a known input kind; anything else, a kind this release does not know included, is not."""
    return isinstance(value, str) and value in INPUT_KINDS


def input_kind_capability(kind: InputKind) -> str:
    """The hello capability a worker declares when it handles turns of this kind."""
    return f"input-kind:{kind}"


# -- images.ts ---------------------------------------------------------------------------------------------------------

_BASE64: Final = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")


def is_invoke_image_mime_type(value: JsonValue) -> TypeIs[InvokeImageMimeType]:
    """Whether ``value`` is one of :data:`INVOKE_IMAGE_MIME_TYPES`."""
    return isinstance(value, str) and value in INVOKE_IMAGE_MIME_TYPES


def is_standard_base64(data: str) -> bool:
    """Non-empty standard base64 (RFC 4648 section 4), padded to a multiple of 4, no prefix, no line breaks."""
    return len(data) > 0 and len(data) % 4 == 0 and _BASE64.fullmatch(data) is not None


def invoke_images_capabilities(invoke: Invoke) -> list[str]:
    """:data:`INVOKE_IMAGES_CAPABILITY` when the invoke carried images, nothing otherwise."""
    if invoke.attachments is not None and len(invoke.attachments) > 0:
        return [INVOKE_IMAGES_CAPABILITY]
    return []


# -- client-catalogs.ts ------------------------------------------------------------------------------------------------

CLIENT_CATALOGS_MAX: Final = 16
"""The most catalog ids one invoke carries; later ones are dropped."""

CLIENT_CATALOG_ID_MAX_CHARS: Final = 64
"""The longest catalog id, in characters."""

CLIENT_CATALOG_ID_PATTERN: Final = re.compile(f"^[A-Za-z0-9._~:/@+-]{{1,{CLIENT_CATALOG_ID_MAX_CHARS}}}$")
"""One catalog id: a URL-safe ASCII class, no whitespace or control characters."""


def parse_client_catalogs(raw: JsonValue) -> tuple[str, ...] | None:
    """The well-formed catalog ids in ``raw``, in order and without repeats, at most :data:`CLIENT_CATALOGS_MAX`.

    A bad entry drops only itself. ``None`` when ``raw`` is not a list or none survives.
    """
    if not isinstance(raw, list):
        return None
    out: list[str] = []
    for entry in raw:
        if len(out) == CLIENT_CATALOGS_MAX:
            break
        if not isinstance(entry, str) or CLIENT_CATALOG_ID_PATTERN.fullmatch(entry) is None or entry in out:
            continue
        out.append(entry)
    return tuple(out) if out else None


# -- end-thread.ts -----------------------------------------------------------------------------------------------------

END_THREAD_CODE_PATTERN: Final = re.compile(r"^[A-Z][A-Z0-9_]{0,39}$")
"""A code is 1-40 characters: an upper-case letter, then upper-case letters, digits or ``_``."""

END_THREAD_MESSAGE_MAX_CHARS: Final = 500
"""The longest message, in characters (code points, not UTF-16 units)."""


def _has_forbidden_control(text: str) -> bool:
    """Whether ``text`` holds a control character other than ``\\n`` (C0, DEL and C1 alike)."""
    for char in text:
        point = ord(char)
        if (point <= 0x1F and point != 0x0A) or 0x7F <= point <= 0x9F:
            return True
    return False


def end_thread_problem(request: EndThread) -> str | None:
    """Why ``request`` is not a valid :class:`EndThread`, or ``None`` when it is. Names the field, never the value."""
    if END_THREAD_CODE_PATTERN.fullmatch(request.code) is None:
        return "code must be 1-40 characters: an upper-case letter, then upper-case letters, digits or _"
    chars = len(request.message)
    if chars == 0 or chars > END_THREAD_MESSAGE_MAX_CHARS:
        return f"message must be 1-{END_THREAD_MESSAGE_MAX_CHARS} characters"
    if _has_forbidden_control(request.message):
        return "message must not contain control characters other than a line feed"
    return None


# -- model-text.ts -----------------------------------------------------------------------------------------------------

CONTEXT_ONLY_TURN_TEXT: Final = (
    "The user sent this turn without any text. Respond to what the page context carries."
)
"""The model-only sentence for a context-only turn. Versioned with this package; never persisted."""

MODEL_TEXT_INPUT_KIND_CAPABILITIES: Final[tuple[str, ...]] = (input_kind_capability("context-only"),)
"""The input kinds :func:`model_text_of` turns into model words, as hello capability names."""


def model_text_of(text: str, input_kind: InputKind | None = None) -> str:
    """The words the model reads for a turn (guuey#2549)."""
    if input_kind != "context-only":
        return text
    if js_trim(text) == "":
        return CONTEXT_ONLY_TURN_TEXT
    return f"{text}\n\n{CONTEXT_ONLY_TURN_TEXT}"


def model_input_of(input: str, input_kind: InputKind | None = None) -> str:
    """The current turn's model text, logging a substitution to stderr (the kind only, never any text)."""
    text = model_text_of(input, input_kind)
    if text != input:
        kind = input_kind if input_kind is not None else "undefined"
        sys.stderr.write(f"[guuey] input substituted: kind={kind}\n")
    return text


# -- cli-session-compare.ts --------------------------------------------------------------------------------------------

type CliSessionRefusal = Literal[
    "unreadable",
    "corrupt",
    "unclassified",
    "no-session-ids",
    "other-session",
    "no-last-prompt",
    "last-prompt-differs",
]


@dataclass(frozen=True, slots=True, kw_only=True)
class CliSessionRecord:
    """What the platform recorded when the thread's last turn ended."""

    id: str
    last_prompt_sha: str


@dataclass(frozen=True, slots=True, kw_only=True)
class CliSessionAccepted:
    ok: Literal[True] = True

    def to_wire(self) -> JsonObject:
        return {"ok": True}


@dataclass(frozen=True, slots=True, kw_only=True)
class CliSessionRefused:
    ok: Literal[False] = False
    reason: CliSessionRefusal

    def to_wire(self) -> JsonObject:
        return {"ok": False, "reason": self.reason}


type CliSessionVerdict = CliSessionAccepted | CliSessionRefused


def compare_stored_session(record: CliSessionRecord, stored: HelloStoredMeasures) -> CliSessionVerdict:
    """Whether the stored session may be resumed for ``record`` (guuey#3407 6a). The one comparison; see the TS doc."""
    if stored.read_error is not None:
        return CliSessionRefused(reason="unreadable")
    if stored.corrupt > 0:
        return CliSessionRefused(reason="corrupt")
    if stored.unclassified > 0:
        return CliSessionRefused(reason="unclassified")
    ids = stored.session_ids
    if ids is None or len(ids) == 0:
        return CliSessionRefused(reason="no-session-ids")
    if any(session_id != record.id for session_id in ids):
        return CliSessionRefused(reason="other-session")
    if len(stored.last_prompt_shas) == 0:
        return CliSessionRefused(reason="no-last-prompt")
    if stored.last_prompt_shas[-1] != record.last_prompt_sha:
        return CliSessionRefused(reason="last-prompt-differs")
    return CliSessionAccepted()


# -- mcp-custom-data.ts ------------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class McpToolCustomData:
    """An MCP tool result's side channel: ``structuredContent`` and ``_meta``, kept out of model-visible text."""

    structured_content: JsonObject | None = None
    meta: JsonObject | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {}
        if self.structured_content is not None:
            out["structuredContent"] = self.structured_content
        if self.meta is not None:
            out["_meta"] = self.meta
        return out


def mcp_tool_custom_data(
    structured_content: JsonObject | None = None, result_meta: JsonObject | None = None
) -> McpToolCustomData | None:
    """``structuredContent`` + ``_meta`` of an MCP tool result, or ``None`` when it has neither (guuey#981)."""
    if structured_content is None and result_meta is None:
        return None
    return McpToolCustomData(structured_content=structured_content, meta=result_meta)
