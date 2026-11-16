"""The typed interpreters for one protocol line: :func:`parse_control` (Router -> worker, fd 0) and :func:`read_event`
(worker -> Router, fd 3). A port of ``@guuey/worker``'s ``parse.ts``.

A malformed line raises :class:`WorkerProtocolError` with the JavaScript parser's message, never a silent skip. A
well-formed line of a type this release does not know comes back as :class:`UnknownControl` / :class:`UnknownEvent`
(guuey#3434), so a newer peer never kills the reader. Every optional member is lenient exactly where the JavaScript
parser is (N-1: a validator never rejects a member the previous release did not send, nor demands one it did not
require): a malformed optional member reads as absent, never as an error.
"""

import enum
import re
from typing import Final, Literal, TypeIs

from guuey_host.protocol import (
    ABSENT,
    SDK_SESSION_IDS_MAX,
    SDK_SESSION_PROMPT_SHAS_MAX,
    AuthMode,
    CliSessionMode,
    ControlMessage,
    DoneEvent,
    EndThread,
    ErrorEvent,
    FirstImpressionPush,
    FirstImpressionShown,
    Fs,
    HelloCliSession,
    HelloHeaderShas,
    HelloSdkHeaderShas,
    HelloSdkSession,
    HelloSdkStored,
    HelloStoredMeasures,
    HelloWalk,
    HistoryMessage,
    Identity,
    Invoke,
    InvokeCliSession,
    InvokeImageAttachment,
    InvokeResume,
    InvokeSuspendOffer,
    InvokeThreadCloseOffer,
    McpAvailability,
    McpAvailabilityState,
    NativeEvent,
    ParsedEvent,
    PriorMemoryRecord,
    ProfileAccess,
    ProfileSection,
    ResumeAnswer,
    ResumeAnswerStatus,
    SdkSessionKind,
    SdkStoredReadError,
    Shutdown,
    StopReason,
    StoredReadError,
    SuspendEvent,
    TextEvent,
    UnknownControl,
    UnknownEvent,
    WalkBoundary,
    WithheldTool,
    WorkerHelloEvent,
    WorkerProtocolError,
)
from guuey_host.protocol_json import JsonObject, JsonSyntaxFailure, JsonValue, js_json_try_parse, utf16_prefix
from guuey_host.protocol_rules import (
    end_thread_problem,
    is_input_kind,
    is_invoke_image_mime_type,
    is_standard_base64,
    parse_client_catalogs,
)

_LINE_EXCERPT_UNITS: Final = 200
"""How much of a malformed line its error names: ``line.slice(0, 200)``, in UTF-16 code units."""


class _Missing(enum.Enum):
    """A member the line does not carry: JavaScript's ``undefined``, which JSON ``null`` is not."""

    MISSING = "missing"


_MISSING: Final = _Missing.MISSING

type _Member = JsonValue | _Missing


def _member(obj: JsonObject, key: str) -> _Member:
    return obj[key] if key in obj else _MISSING


def _is_object(value: _Member) -> TypeIs[JsonObject]:
    """A JSON object: not an array, not null."""
    return isinstance(value, dict)


def _integer(value: _Member) -> int | None:
    """The value when it is a JavaScript number for which ``Number.isInteger`` holds, else ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _count(value: _Member) -> int | None:
    """A non-negative integer (``isCount``), else ``None``."""
    number = _integer(value)
    return number if number is not None and number >= 0 else None


def _is_stop_reason_override(value: _Member) -> TypeIs[Literal["max_turns", "error"]]:
    return isinstance(value, str) and value in ("max_turns", "error")


def _is_profile_access(value: _Member) -> TypeIs[ProfileAccess]:
    return isinstance(value, str) and value in ("read", "read-write")


def _is_resume_answer_status(value: _Member) -> TypeIs[ResumeAnswerStatus]:
    return isinstance(value, str) and value in ("resolved", "declined")


def _is_cli_session_mode(value: _Member) -> TypeIs[CliSessionMode]:
    return isinstance(value, str) and value in ("start", "resume")


def _string_list(value: _Member) -> tuple[str, ...] | None:
    if not isinstance(value, list):
        return None
    out: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return None
        out.append(item)
    return tuple(out)


def is_invoke(message: ControlMessage) -> TypeIs[Invoke]:
    return isinstance(message, Invoke)


def is_shutdown(message: ControlMessage) -> TypeIs[Shutdown]:
    return isinstance(message, Shutdown)


def is_unknown_control(message: ControlMessage) -> TypeIs[UnknownControl]:
    return isinstance(message, UnknownControl)


# -- the invoke's members ----------------------------------------------------------------------------------------------


def _parse_identity(value: _Member) -> Identity:
    if not _is_object(value):
        raise WorkerProtocolError("invoke.identity missing string `userId`")
    user_id = _member(value, "userId")
    if not isinstance(user_id, str):
        raise WorkerProtocolError("invoke.identity missing string `userId`")
    auth_mode: AuthMode = "authenticated" if _member(value, "authMode") == "authenticated" else "anonymous"
    return Identity(user_id=user_id, auth_mode=auth_mode)


def _parse_fs(value: _Member) -> Fs:
    if _is_object(value):
        app, home, session = _member(value, "app"), _member(value, "home"), _member(value, "session")
        if isinstance(app, str) and isinstance(home, str) and isinstance(session, str):
            return Fs(app=app, home=home, session=session)
    raise WorkerProtocolError("invoke.fs missing string `app`/`home`/`session`")


def _parse_history(value: _Member) -> tuple[HistoryMessage, ...]:
    if value is _MISSING:
        return ()
    if not isinstance(value, list):
        raise WorkerProtocolError("invoke.history must be an array")
    out: list[HistoryMessage] = []
    for entry in value:
        if not _is_object(entry):
            raise WorkerProtocolError("invoke.history entry missing string `text`")
        text = _member(entry, "text")
        if not isinstance(text, str):
            raise WorkerProtocolError("invoke.history entry missing string `text`")
        kind = _member(entry, "inputKind")
        out.append(
            HistoryMessage(
                role="agent" if _member(entry, "role") == "agent" else "user",
                text=text,
                # guuey#2549: an unknown kind reads as none (additive, never fatal).
                input_kind=kind if not isinstance(kind, _Missing) and is_input_kind(kind) else None,
            )
        )
    return tuple(out)


def _parse_prior_memory(value: _Member) -> tuple[PriorMemoryRecord, ...] | None:
    """Lenient: an entry that is not an object or has no ``value`` is dropped; ``None`` when nothing survives."""
    if not isinstance(value, list):
        return None
    out: list[PriorMemoryRecord] = []
    for entry in value:
        if _is_object(entry) and "value" in entry:
            key = _member(entry, "key")
            out.append(PriorMemoryRecord(value=entry["value"], key=key if isinstance(key, str) else None))
    return tuple(out) if out else None


def _parse_first_impression(value: _Member) -> FirstImpressionPush | None:
    """The identity fields (plus ``variance`` when a non-empty object, guuey#1256), or nothing."""
    if not _is_object(value):
        return None
    chip_key, intent, contract = _member(value, "chipKey"), _member(value, "intent"), _member(value, "contract")
    if not isinstance(chip_key, str) or chip_key == "":
        return None
    if not isinstance(intent, str) or intent == "":
        return None
    if not _is_object(contract):
        return None
    variance = _member(value, "variance")
    blueprint_id = _member(value, "blueprintId")
    return FirstImpressionPush(
        chip_key=chip_key,
        intent=intent,
        contract=contract,
        blueprint_id=blueprint_id if isinstance(blueprint_id, str) and blueprint_id != "" else None,
        variance=variance if _is_object(variance) and len(variance) > 0 else None,
    )


def _parse_profile_sections(value: _Member) -> tuple[ProfileSection, ...] | None:
    if not isinstance(value, list):
        return None
    out: list[ProfileSection] = []
    for entry in value:
        if _is_object(entry):
            app, content = _member(entry, "app"), _member(entry, "content")
            if isinstance(app, str) and isinstance(content, str):
                out.append(ProfileSection(app=app, content=content))
    return tuple(out) if out else None


def _is_mcp_availability_state(value: _Member) -> TypeIs[McpAvailabilityState]:
    return isinstance(value, str) and value in ("connected", "needs_authorization", "denied", "unavailable")


def _parse_mcp_availability(value: _Member) -> tuple[McpAvailability, ...] | None:
    """guuey#901: a malformed entry is dropped, not coerced; ``None`` when nothing survives."""
    if not isinstance(value, list):
        return None
    out: list[McpAvailability] = []
    for entry in value:
        if not _is_object(entry):
            continue
        server, state = _member(entry, "server"), _member(entry, "state")
        if not isinstance(server, str) or len(server) == 0:
            continue
        if not _is_mcp_availability_state(state):
            continue
        out.append(McpAvailability(server=server, state=state))
    return tuple(out) if out else None


def _parse_suspend_offer(value: _Member) -> InvokeSuspendOffer | None:
    """Kept only when ``maxEnvelopeBytes`` is a positive integer, reduced to that one member."""
    if not _is_object(value):
        return None
    maximum = _integer(_member(value, "maxEnvelopeBytes"))
    if maximum is None or maximum <= 0:
        return None
    return InvokeSuspendOffer(max_envelope_bytes=maximum)


def _parse_resume_answer(value: JsonValue) -> ResumeAnswer | None:
    if not _is_object(value):
        return None
    ask_id, tool_call_id, status = _member(value, "askId"), _member(value, "toolCallId"), _member(value, "status")
    if not isinstance(ask_id, str) or len(ask_id) == 0:
        return None
    if not isinstance(tool_call_id, str) or len(tool_call_id) == 0:
        return None
    if not _is_resume_answer_status(status):
        return None
    return ResumeAnswer(ask_id=ask_id, tool_call_id=tool_call_id, status=status)


def _parse_resume(value: _Member) -> InvokeResume | None:
    """Kept only when EVERY part is well formed; anything else drops the whole value, never part of it."""
    if not _is_object(value):
        return None
    envelope, answers = _member(value, "envelope"), _member(value, "answers")
    if not isinstance(envelope, str) or len(envelope) == 0:
        return None
    if not isinstance(answers, list) or len(answers) == 0:
        return None
    parsed: list[ResumeAnswer] = []
    for entry in answers:
        answer = _parse_resume_answer(entry)
        if answer is None:
            return None
        parsed.append(answer)
    paused_user_seq = _member(value, "pausedUserSeq")
    if paused_user_seq is not _MISSING:
        seq = _count(paused_user_seq)
        if seq is None:
            return None
        return InvokeResume(envelope=envelope, answers=tuple(parsed), paused_user_seq=seq)
    return InvokeResume(envelope=envelope, answers=tuple(parsed))


def _parse_attachments(value: _Member) -> tuple[InvokeImageAttachment, ...] | None:
    """Kept only when EVERY entry is a well-formed inline image; anything else drops the whole list."""
    if not isinstance(value, list) or len(value) == 0:
        return None
    out: list[InvokeImageAttachment] = []
    for entry in value:
        if not _is_object(entry) or _member(entry, "kind") != "inline":
            return None
        mime_type, data = _member(entry, "mimeType"), _member(entry, "data")
        if isinstance(mime_type, _Missing) or not is_invoke_image_mime_type(mime_type):
            return None
        if not isinstance(data, str) or not is_standard_base64(data):
            return None
        out.append(InvokeImageAttachment(mime_type=mime_type, data=data))
    return tuple(out)


_SHA256_HEX: Final = re.compile(r"^[0-9a-f]{64}$")
"""A sha the host computes: 64 lowercase hex."""


def _parse_invoke_cli_session(value: _Member) -> InvokeCliSession | None:
    """A well-formed ``{mode, id}`` with a known mode and a non-empty id, or nothing (guuey#3407 B3)."""
    if not _is_object(value):
        return None
    mode, session_id = _member(value, "mode"), _member(value, "id")
    if not _is_cli_session_mode(mode) or not isinstance(session_id, str) or len(session_id) == 0:
        return None
    expect = _member(value, "expectLastPromptSha")
    if expect is _MISSING:
        return InvokeCliSession(mode=mode, id=session_id)
    # Present but malformed drops the member whole: the turn runs without a resume, never with an unchecked one.
    if not isinstance(expect, str) or _SHA256_HEX.fullmatch(expect) is None:
        return None
    return InvokeCliSession(mode=mode, id=session_id, expect_last_prompt_sha=expect)


def _parse_first_impression_shown(value: _Member) -> FirstImpressionShown | None:
    """Reduced to its three members; any malformed member drops the whole value."""
    if not _is_object(value):
        return None
    heading, message, options = _member(value, "heading"), _member(value, "message"), _member(value, "options")
    if not isinstance(heading, str) or len(heading) == 0 or not isinstance(message, str):
        return None
    labels = _string_list(options)
    if labels is None:
        return None
    return FirstImpressionShown(heading=heading, message=message, options=labels)


def _parse_withheld_tools(value: _Member) -> tuple[WithheldTool, ...]:
    """The well-formed entries, each reduced to ``{server, tool}``; anything else is dropped."""
    if not isinstance(value, list):
        return ()
    out: list[WithheldTool] = []
    for entry in value:
        if not _is_object(entry):
            continue
        server, tool = _member(entry, "server"), _member(entry, "tool")
        if isinstance(server, str) and len(server) > 0 and isinstance(tool, str) and len(tool) > 0:
            out.append(WithheldTool(server=server, tool=tool))
    return tuple(out)


def _parse_invoke(raw: JsonObject) -> Invoke:
    line_input = _member(raw, "input")
    if not isinstance(line_input, str):
        raise WorkerProtocolError("invoke missing string `input`")
    # The lenient members first (they never raise), then the required ones in the JavaScript evaluation order, so
    # the first malformed required member names the same error: identity, then fs, then history.
    input_kind = _member(raw, "inputKind")
    fs_bound = _member(raw, "fsBound")
    prior_state = _member(raw, "priorState")
    user_memory = _member(raw, "userMemory")
    memory_attached = _member(raw, "memoryAttached")
    profile_access = _member(raw, "profileAccess")
    resource_count = _integer(_member(raw, "resourceCount"))
    ggui_attached = _member(raw, "gguiAttached")
    withheld_tools = _parse_withheld_tools(_member(raw, "withheldTools"))
    client_catalogs = _member(raw, "clientCatalogs")
    thread_id = _member(raw, "threadId")
    identity = _parse_identity(_member(raw, "identity"))
    fs = _parse_fs(_member(raw, "fs"))
    history = _parse_history(_member(raw, "history"))
    return Invoke(
        input=line_input,
        input_kind=input_kind if not isinstance(input_kind, _Missing) and is_input_kind(input_kind) else None,
        identity=identity,
        fs=fs,
        fs_bound=fs_bound if isinstance(fs_bound, bool) else None,
        history=history,
        prior_memory=_parse_prior_memory(_member(raw, "priorMemory")),
        prior_state=ABSENT if isinstance(prior_state, _Missing) else prior_state,
        user_memory=user_memory if isinstance(user_memory, str) else None,
        memory_attached=memory_attached if isinstance(memory_attached, bool) else None,
        profile_access=profile_access if _is_profile_access(profile_access) else None,
        profile_sections=_parse_profile_sections(_member(raw, "profileSections")),
        first_impression=_parse_first_impression(_member(raw, "firstImpression")),
        mcp_availability=_parse_mcp_availability(_member(raw, "mcpAvailability")),
        resource_count=resource_count if resource_count is not None and resource_count > 0 else None,
        ggui_attached=ggui_attached if isinstance(ggui_attached, bool) else None,
        client_catalogs=None if isinstance(client_catalogs, _Missing) else parse_client_catalogs(client_catalogs),
        withheld_tools=withheld_tools if withheld_tools else None,
        first_impression_shown=_parse_first_impression_shown(_member(raw, "firstImpressionShown")),
        suspend=_parse_suspend_offer(_member(raw, "suspend")),
        resume=_parse_resume(_member(raw, "resume")),
        thread_close=InvokeThreadCloseOffer() if _is_object(_member(raw, "threadClose")) else None,
        thread_id=thread_id if isinstance(thread_id, str) and len(thread_id) > 0 else None,
        attachments=_parse_attachments(_member(raw, "attachments")),
        cli_session=_parse_invoke_cli_session(_member(raw, "cliSession")),
    )


def _read_line_object(line: str, direction: str) -> JsonObject:
    raw = js_json_try_parse(line)
    if isinstance(raw, JsonSyntaxFailure):
        raise WorkerProtocolError(f"non-JSON {direction} line: {utf16_prefix(line, _LINE_EXCERPT_UNITS)}")
    if not _is_object(raw):
        raise WorkerProtocolError(f"{direction} line is not an object: {utf16_prefix(line, _LINE_EXCERPT_UNITS)}")
    return raw


def parse_control(line: str) -> ControlMessage:
    """Validate one control line (Router -> worker, fd 0) into a typed :data:`ControlMessage`."""
    raw = _read_line_object(line, "control")
    kind = _member(raw, "type")
    if kind == "invoke":
        return _parse_invoke(raw)
    if kind == "shutdown":
        return Shutdown()
    # guuey#3434: a type a NEWER Router may send. Returned, never raised; a line with no string `type` still raises.
    if isinstance(kind, str):
        return UnknownControl(raw_type=kind)
    raise WorkerProtocolError("control line has no string `type`")


# -- the event direction -----------------------------------------------------------------------------------------------


def is_text(event: ParsedEvent) -> TypeIs[TextEvent]:
    return isinstance(event, TextEvent)


def is_done(event: ParsedEvent) -> TypeIs[DoneEvent]:
    return isinstance(event, DoneEvent)


def is_error(event: ParsedEvent) -> TypeIs[ErrorEvent]:
    return isinstance(event, ErrorEvent)


def is_native(event: ParsedEvent) -> TypeIs[NativeEvent]:
    return isinstance(event, NativeEvent)


def is_hello(event: ParsedEvent) -> TypeIs[WorkerHelloEvent]:
    return isinstance(event, WorkerHelloEvent)


def is_suspend(event: ParsedEvent) -> TypeIs[SuspendEvent]:
    return isinstance(event, SuspendEvent)


def is_unknown_event(event: ParsedEvent) -> TypeIs[UnknownEvent]:
    return isinstance(event, UnknownEvent)


def _parse_header_shas(value: _Member) -> HelloHeaderShas | None:
    if not _is_object(value):
        return None
    model, permission_mode = _member(value, "model"), _member(value, "permissionMode")
    tools, mcp_config = _member(value, "tools"), _member(value, "mcpConfig")
    if (
        not isinstance(model, str)
        or not isinstance(permission_mode, str)
        or not isinstance(tools, str)
        or not isinstance(mcp_config, str)
    ):
        return None
    return HelloHeaderShas(model=model, permission_mode=permission_mode, tools=tools, mcp_config=mcp_config)


def _is_walk_boundary(value: _Member) -> TypeIs[WalkBoundary]:
    return isinstance(value, str) and value in ("none", "links-other-leaf", "dangling")


def _parse_walk(value: JsonValue) -> HelloWalk | None:
    if not _is_object(value):
        return None
    prompt_shas = _string_list(_member(value, "promptShas"))
    from_leaf = _member(value, "fromLastPromptLeaf")
    compact_summaries = _count(_member(value, "compactSummaries"))
    boundary = _member(value, "boundary")
    if not isinstance(from_leaf, bool) or prompt_shas is None or compact_summaries is None:
        return None
    if not _is_walk_boundary(boundary):
        return None
    return HelloWalk(
        from_last_prompt_leaf=from_leaf,
        prompt_shas=prompt_shas,
        compact_summaries=compact_summaries,
        boundary=boundary,
    )


def _is_stored_read_error(value: _Member) -> TypeIs[StoredReadError]:
    return isinstance(value, str) and value in ("missing", "not-regular", "link")


def _parse_stored_measures(value: _Member) -> HelloStoredMeasures | None:
    """The stored measures, kept whole or dropped whole."""
    if not _is_object(value):
        return None
    read_error = _member(value, "readError")
    if read_error is not _MISSING and not _is_stored_read_error(read_error):
        return None
    system_prompt_shas = _string_list(_member(value, "systemPromptShas"))
    last_prompt_shas = _string_list(_member(value, "lastPromptShas"))
    entries = _string_list(_member(value, "entries"))
    walks_value = _member(value, "walks")
    if system_prompt_shas is None or last_prompt_shas is None or entries is None or not isinstance(walks_value, list):
        return None
    # Optional (added after wire v1.2): absent from an older host; present but malformed drops the block whole.
    session_ids_value = _member(value, "sessionIds")
    session_ids = None if session_ids_value is _MISSING else _string_list(session_ids_value)
    if session_ids_value is not _MISSING and session_ids is None:
        return None
    walks: list[HelloWalk] = []
    for item in walks_value:
        walk = _parse_walk(item)
        if walk is None:
            return None
        walks.append(walk)
    unclassified = _count(_member(value, "unclassified"))
    corrupt = _count(_member(value, "corrupt"))
    benign_duplicates = _count(_member(value, "benignDuplicates"))
    file_prompt_entries = _count(_member(value, "filePromptEntries"))
    file_compact_summaries = _count(_member(value, "fileCompactSummaries"))
    if (
        unclassified is None
        or corrupt is None
        or benign_duplicates is None
        or file_prompt_entries is None
        or file_compact_summaries is None
    ):
        return None
    return HelloStoredMeasures(
        read_error=read_error if _is_stored_read_error(read_error) else None,
        system_prompt_shas=system_prompt_shas,
        walks=tuple(walks),
        last_prompt_shas=last_prompt_shas,
        session_ids=session_ids,
        entries=entries,
        unclassified=unclassified,
        corrupt=corrupt,
        benign_duplicates=benign_duplicates,
        file_prompt_entries=file_prompt_entries,
        file_compact_summaries=file_compact_summaries,
    )


def _parse_hello_cli_session(value: _Member) -> HelloCliSession | None:
    """The hello's thread-resume block: kept WHOLE when every member is well formed, otherwise dropped whole."""
    if not _is_object(value):
        return None
    hash_version = _count(_member(value, "hashVersion"))
    system_prompt_sha256 = _member(value, "systemPromptSha256")
    header_shas = _parse_header_shas(_member(value, "headerShas"))
    if hash_version is None or not isinstance(system_prompt_sha256, str) or header_shas is None:
        return None
    prompt_sha, last_prompt_sha = _member(value, "promptSha"), _member(value, "lastPromptSha")
    prompt_bytes = _count(_member(value, "promptBytes"))
    if not isinstance(prompt_sha, str) or prompt_bytes is None or not isinstance(last_prompt_sha, str):
        return None
    stored_value = _member(value, "stored")
    stored: HelloStoredMeasures | None = None
    if stored_value is not _MISSING:
        stored = _parse_stored_measures(stored_value)
        if stored is None:
            return None
    return HelloCliSession(
        hash_version=hash_version,
        system_prompt_sha256=system_prompt_sha256,
        header_shas=header_shas,
        prompt_sha=prompt_sha,
        prompt_bytes=prompt_bytes,
        last_prompt_sha=last_prompt_sha,
        stored=stored,
    )


_UUID: Final = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
"""A UUID, the grammar ``@guuey/host`` holds an invoke's ``cliSession.id`` to: 8-4-4-4-12 hex, either case. Matched
with ``fullmatch`` only, as JavaScript's anchored ``^...$`` (no trailing newline slips through)."""


_EMPTY_SHA256: Final = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
"""The plain sha256 of no bytes: a ``stored.fileSha256`` on a ``readError``."""


def _is_sha(value: _Member) -> TypeIs[str]:
    """64 lowercase hex."""
    return isinstance(value, str) and _SHA256_HEX.fullmatch(value) is not None


def _is_sdk_session_kind(value: _Member) -> TypeIs[SdkSessionKind]:
    return isinstance(value, str) and value in ("openai-agents", "google-adk")


def _is_sdk_stored_read_error(value: _Member) -> TypeIs[SdkStoredReadError]:
    return isinstance(value, str) and value in ("missing", "not-regular", "link", "side-file")


def _bounded_list(value: _Member, maximum: int, entry: re.Pattern[str]) -> tuple[str, ...] | None:
    """A list of strings of at most ``maximum`` entries, each matching ``entry`` whole, or ``None``."""
    items = _string_list(value)
    if items is None or len(items) > maximum:
        return None
    if not all(entry.fullmatch(item) is not None for item in items):
        return None
    return items


def _parse_sdk_header_shas(value: _Member) -> HelloSdkHeaderShas | None:
    if not _is_object(value):
        return None
    model, tools, mcp_config = _member(value, "model"), _member(value, "tools"), _member(value, "mcpConfig")
    if not _is_sha(model) or not _is_sha(tools) or not _is_sha(mcp_config):
        return None
    return HelloSdkHeaderShas(model=model, tools=tools, mcp_config=mcp_config)


def _parse_sdk_stored(value: _Member) -> HelloSdkStored | None:
    """The SDK store's measures, kept whole or dropped whole."""
    if not _is_object(value):
        return None
    read_error = _member(value, "readError")
    if read_error is not _MISSING and not _is_sdk_stored_read_error(read_error):
        return None
    prompt_shas = _bounded_list(_member(value, "promptShas"), SDK_SESSION_PROMPT_SHAS_MAX, _SHA256_HEX)
    last_prompt_shas = _bounded_list(_member(value, "lastPromptShas"), SDK_SESSION_PROMPT_SHAS_MAX, _SHA256_HEX)
    session_ids = _bounded_list(_member(value, "sessionIds"), SDK_SESSION_IDS_MAX, _UUID)
    file_sha256 = _member(value, "fileSha256")
    if not _is_sha(file_sha256) or prompt_shas is None or last_prompt_shas is None or session_ids is None:
        return None
    item_count = _count(_member(value, "itemCount"))
    corrupt = _count(_member(value, "corrupt"))
    unclassified = _count(_member(value, "unclassified"))
    compactions = _count(_member(value, "compactions"))
    if item_count is None or corrupt is None or unclassified is None or compactions is None:
        return None
    # Entry i of each prompt list is turn i's, so the two lists are the same length.
    if len(prompt_shas) != len(last_prompt_shas):
        return None
    # Every DISTINCT session id: a byte-equal repeat is not a measure the host takes.
    if len(frozenset(session_ids)) != len(session_ids):
        return None
    # A store that could not be read was never opened: nothing listed, nothing counted, the sha256 of no bytes.
    if read_error is not _MISSING:
        if prompt_shas or last_prompt_shas or session_ids:
            return None
        if item_count != 0 or corrupt != 0 or unclassified != 0 or compactions != 0:
            return None
        if file_sha256 != _EMPTY_SHA256:
            return None
    return HelloSdkStored(
        read_error=read_error if _is_sdk_stored_read_error(read_error) else None,
        file_sha256=file_sha256,
        item_count=item_count,
        prompt_shas=prompt_shas,
        last_prompt_shas=last_prompt_shas,
        session_ids=session_ids,
        corrupt=corrupt,
        unclassified=unclassified,
        compactions=compactions,
    )


def _parse_hello_sdk_session(value: _Member) -> HelloSdkSession | None:
    """The hello's SDK thread-resume block (guuey#3517): kept WHOLE when every member is well formed and within
    bounds, otherwise dropped whole. The bounds are ``parse.ts``'s: every sha 64 lowercase hex, every count an integer
    of at least 0 and ``hashVersion`` of at least 1, the prompt lists at most :data:`SDK_SESSION_PROMPT_SHAS_MAX`
    entries each and of equal length, ``sessionIds`` at most :data:`SDK_SESSION_IDS_MAX` UUIDs with no two byte-equal,
    on a ``readError`` every list empty, every count 0 and ``fileSha256`` the sha256 of no bytes, ``kind`` a known
    SDK."""
    if not _is_object(value):
        return None
    kind = _member(value, "kind")
    hash_version = _count(_member(value, "hashVersion"))
    system_prompt_sha256 = _member(value, "systemPromptSha256")
    header_shas = _parse_sdk_header_shas(_member(value, "headerShas"))
    if not _is_sdk_session_kind(kind) or hash_version is None or hash_version < 1:
        return None
    if not _is_sha(system_prompt_sha256) or header_shas is None:
        return None
    prompt_sha, last_prompt_sha = _member(value, "promptSha"), _member(value, "lastPromptSha")
    prompt_bytes = _count(_member(value, "promptBytes"))
    if not _is_sha(prompt_sha) or prompt_bytes is None or not _is_sha(last_prompt_sha):
        return None
    stored_value = _member(value, "stored")
    stored: HelloSdkStored | None = None
    if stored_value is not _MISSING:
        stored = _parse_sdk_stored(stored_value)
        if stored is None:
            return None
    return HelloSdkSession(
        kind=kind,
        hash_version=hash_version,
        system_prompt_sha256=system_prompt_sha256,
        header_shas=header_shas,
        prompt_sha=prompt_sha,
        prompt_bytes=prompt_bytes,
        last_prompt_sha=last_prompt_sha,
        stored=stored,
    )


def _parse_end_thread(value: _Member) -> EndThread | None:
    """A ``done``'s request to end the conversation: kept only when it passes :func:`end_thread_problem`."""
    if not _is_object(value):
        return None
    code, message = _member(value, "code"), _member(value, "message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    request = EndThread(code=code, message=message)
    return request if end_thread_problem(request) is None else None


def read_event(line: str) -> ParsedEvent:
    """Validate one event line (worker -> Router, fd 3) into a typed :data:`ParsedEvent`."""
    raw = _read_line_object(line, "event")
    kind = _member(raw, "type")
    if kind == "text":
        text = _member(raw, "text")
        if not isinstance(text, str):
            raise WorkerProtocolError("text event missing string `text`")
        return TextEvent(text=text)
    if kind == "done":
        stop = _member(raw, "stopReason")
        stop_reason: StopReason = stop if _is_stop_reason_override(stop) else "end_turn"
        result = _member(raw, "result")
        return DoneEvent(
            stop_reason=stop_reason,
            result=result if isinstance(result, str) else "",
            end_thread=_parse_end_thread(_member(raw, "endThread")),
        )
    if kind == "error":
        message = _member(raw, "message")
        return ErrorEvent(message=message if isinstance(message, str) else "unknown worker error")
    if kind == "native":
        framework = _member(raw, "framework")
        if not isinstance(framework, str):
            raise WorkerProtocolError("native event missing string `framework`")
        event = _member(raw, "event")
        if isinstance(event, _Missing):
            raise WorkerProtocolError("native event missing `event`")
        return NativeEvent(framework=framework, event=event)
    if kind == "hello":
        framework = _member(raw, "framework")
        if not isinstance(framework, str):
            raise WorkerProtocolError("hello event missing string `framework`")
        sdk_name, sdk_version = _member(raw, "sdkName"), _member(raw, "sdkVersion")
        # Additive-optional: kept only as a non-empty list of strings; any other shape reads as none.
        capabilities = _string_list(_member(raw, "capabilities"))
        return WorkerHelloEvent(
            framework=framework,
            sdk_name=sdk_name if isinstance(sdk_name, str) else None,
            sdk_version=sdk_version if isinstance(sdk_version, str) else None,
            capabilities=capabilities if capabilities else None,
            cli_session=_parse_hello_cli_session(_member(raw, "cliSession")),
            # SDK thread resume (guuey#3517): the same whole-or-dropped rule for an SDK's own session store.
            session=_parse_hello_sdk_session(_member(raw, "session")),
        )
    if kind == "suspend":
        envelope = _member(raw, "envelope")
        if not isinstance(envelope, str):
            raise WorkerProtocolError("suspend event missing string `envelope`")
        ask_ids = _string_list(_member(raw, "askIds"))
        if ask_ids is None:
            raise WorkerProtocolError("suspend event `askIds` must be a list of strings")
        return SuspendEvent(envelope=envelope, ask_ids=ask_ids)
    # guuey#3434: a type a NEWER worker may emit. Returned, never raised; a line with no string `type` still raises.
    if isinstance(kind, str):
        return UnknownEvent(raw_type=kind)
    raise WorkerProtocolError("event line has no string `type`")
