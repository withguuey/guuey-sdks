"""Guuey Worker Protocol v1: the frozen, versioned wire types the Router and a worker exchange.

A port of ``@guuey/worker``'s ``protocol.ts`` (the source of truth; this file follows it). Each wire shape is a frozen
dataclass with snake_case attributes; ``to_wire()`` gives the JSON object exactly as the JavaScript side builds it,
camelCase keys in the JavaScript key order, optional members omitted when absent. Serialize with
:func:`guuey_host.protocol_json.js_json_stringify` to get the bytes the JavaScript side writes.

  Router -> Worker  (fd 0 / stdin):  ControlMessage  (invoke | shutdown | unknown)
  Worker -> Router  (fd 3):          WorkerEvent     (text | done | error | native | hello | suspend)
  stdout (1) + stderr (2):           the builder's own logs, not the protocol.

Absent versus null: JavaScript tells an absent member (``undefined``) from JSON ``null``. Optional members here use
``None`` for absent wherever ``null`` is not a value the member can hold; the one member that can hold any JSON value,
``Invoke.prior_state``, uses :data:`ABSENT`.
"""

import enum
from dataclasses import dataclass
from typing import ClassVar, Final, Literal

from guuey_host.protocol_json import JsonObject, JsonValue

PROTOCOL_VERSION: Final = "v1"
"""v1: the worker-facing half of Guuey Router v1 (pinned via ``runtime.router``)."""

type ProtocolVersion = Literal["v1"]
type AuthMode = Literal["anonymous", "authenticated"]
type HistoryRole = Literal["user", "agent"]
type StopReason = Literal["end_turn", "max_turns", "error"]
type McpAvailabilityState = Literal["connected", "needs_authorization", "denied", "unavailable"]
type ProfileAccess = Literal["read", "read-write"]
type ResumeAnswerStatus = Literal["resolved", "declined"]
type CliSessionMode = Literal["start", "resume"]
type StoredReadError = Literal["missing", "not-regular", "link"]
type WalkBoundary = Literal["none", "links-other-leaf", "dangling"]

type InputKind = Literal["context-only"]
"""What a user turn's content rides on when its text is empty (guuey#2549; input-kinds.ts)."""

INPUT_KINDS: Final[tuple[InputKind, ...]] = ("context-only",)
"""Every input kind, in wire spelling. More kinds are added additively, here and in input-kinds.ts only."""

type InvokeImageMimeType = Literal["image/jpeg", "image/png", "image/gif", "image/webp"]
INVOKE_IMAGE_MIME_TYPES: Final[tuple[InvokeImageMimeType, ...]] = ("image/jpeg", "image/png", "image/gif", "image/webp")
"""The image types an :class:`InvokeImageAttachment` may carry."""

INVOKE_IMAGES_CAPABILITY: Final = "invoke.images.v1"
"""Capability: this worker hands the invoke's attachments to its model with the turn's input."""

HOST_SUSPEND_CAPABILITY: Final = "host.suspend.v1"
"""Capability: this worker honours ``Invoke.suspend`` and ``Invoke.resume``."""

SUSPEND_ENVELOPE_MAX_BYTES: Final = 2 * 1024 * 1024
"""The largest envelope any worker may emit, in UTF-8 bytes of the envelope's JSON-string form."""

CLI_SESSION_CAPABILITY: Final = "cli-session.v1"
"""Capability: this host runs the invoke's ``cliSession`` and reports ``WorkerHelloEvent.cli_session``."""

CLI_SESSION_HASH_VERSION: Final = 1
"""The form of ``@guuey/host``'s content hash; bumped whenever that form changes."""

CLI_SESSION_RESUME_FAILED: Final = "cli_session_resume_failed"
"""The ``error`` event's message prefix when a ``resume`` could not be confirmed."""

ADK_HOST_COMPLETION_CAPABILITY: Final = "adk.host-completion"
"""Capability: this worker feeds the google-adk normalizer the ``__host_complete__`` sentinel after a normal run."""

TOOL_GATES_CAPABILITY: Final = "tool-gates.v1"
"""Capability: this worker applies the agent's tool gates and the invoke's ``withheldTools`` itself."""


class Absent(enum.Enum):
    """The absent marker for a member whose present value may be JSON ``null``."""

    ABSENT = "absent"


ABSENT: Final = Absent.ABSENT


# -- shared shapes -----------------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class Identity:
    """Router-vouched end-user identity (the worker writes zero auth code)."""

    user_id: str
    auth_mode: AuthMode

    def to_wire(self) -> JsonObject:
        return {"userId": self.user_id, "authMode": self.auth_mode}


@dataclass(frozen=True, slots=True, kw_only=True)
class Fs:
    """The three GuueyFS layer mounts the worker reads and writes."""

    app: str
    home: str
    session: str

    def to_wire(self) -> JsonObject:
        return {"app": self.app, "home": self.home, "session": self.session}


@dataclass(frozen=True, slots=True, kw_only=True)
class HistoryMessage:
    role: HistoryRole
    text: str
    input_kind: InputKind | None = None
    """Set on a user turn whose text is empty because its content rode on the input kind (guuey#2549)."""

    def to_wire(self) -> JsonObject:
        out: JsonObject = {"role": self.role, "text": self.text}
        if self.input_kind is not None:
            out["inputKind"] = self.input_kind
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class PriorMemoryRecord:
    """One prior-memory record pushed by value on the invoke (section 1.4). ``value`` required, ``key`` optional."""

    value: JsonValue
    key: str | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {"value": self.value}
        if self.key is not None:
            out["key"] = self.key
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class FirstImpressionPush:
    """A pre-minted ggui blueprint bound for exactly this turn (guuey#1183). ``contract`` is forwarded verbatim."""

    chip_key: str
    intent: str
    contract: JsonObject
    blueprint_id: str | None = None
    variance: JsonObject | None = None
    """Present only for a variance-named binding (guuey#1256); never empty."""

    def to_wire(self) -> JsonObject:
        out: JsonObject = {"chipKey": self.chip_key, "intent": self.intent, "contract": self.contract}
        if self.blueprint_id is not None:
            out["blueprintId"] = self.blueprint_id
        if self.variance is not None:
            out["variance"] = self.variance
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class ProfileSection:
    """One app's section of the user's cross-app profile; ``app == ""`` marks the truncation line."""

    app: str
    content: str

    def to_wire(self) -> JsonObject:
        return {"app": self.app, "content": self.content}


@dataclass(frozen=True, slots=True, kw_only=True)
class McpAvailability:
    """A ``credential: 'oauth'`` server's availability this turn (guuey#901)."""

    server: str
    state: McpAvailabilityState

    def to_wire(self) -> JsonObject:
        return {"server": self.server, "state": self.state}


@dataclass(frozen=True, slots=True, kw_only=True)
class InvokeImageAttachment:
    """One attached image: standard base64 (no ``data:`` prefix, no line breaks) and its type."""

    kind: ClassVar[Literal["inline"]] = "inline"
    mime_type: InvokeImageMimeType
    data: str

    def to_wire(self) -> JsonObject:
        return {"kind": self.kind, "mimeType": self.mime_type, "data": self.data}


@dataclass(frozen=True, slots=True, kw_only=True)
class InvokeSuspendOffer:
    """Router -> worker: "I can store a pause for this turn, up to this many bytes of envelope"."""

    max_envelope_bytes: int

    def to_wire(self) -> JsonObject:
        return {"maxEnvelopeBytes": self.max_envelope_bytes}


@dataclass(frozen=True, slots=True, kw_only=True)
class ResumeAnswer:
    """One decision on a pending ask."""

    ask_id: str
    tool_call_id: str
    status: ResumeAnswerStatus

    def to_wire(self) -> JsonObject:
        return {"askId": self.ask_id, "toolCallId": self.tool_call_id, "status": self.status}


@dataclass(frozen=True, slots=True, kw_only=True)
class InvokeResume:
    """Router -> worker: continue the paused run whose state is ``envelope``, with these decisions."""

    envelope: str
    answers: tuple[ResumeAnswer, ...]
    paused_user_seq: int | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {"envelope": self.envelope, "answers": [answer.to_wire() for answer in self.answers]}
        if self.paused_user_seq is not None:
            out["pausedUserSeq"] = self.paused_user_seq
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class WithheldTool:
    """One tool withheld from a turn's catalog: the MCP server's key and the tool's name on it."""

    server: str
    tool: str

    def to_wire(self) -> JsonObject:
        return {"server": self.server, "tool": self.tool}


@dataclass(frozen=True, slots=True, kw_only=True)
class FirstImpressionShown:
    """What the Router's welcome card shows: its heading, its message, and its option labels."""

    heading: str
    message: str
    options: tuple[str, ...]

    def to_wire(self) -> JsonObject:
        return {"heading": self.heading, "message": self.message, "options": list(self.options)}


@dataclass(frozen=True, slots=True, kw_only=True)
class InvokeThreadCloseOffer:
    """Router -> worker: "I can end this conversation for you on this turn". No fields; its presence is the offer."""

    def to_wire(self) -> JsonObject:
        return {}


@dataclass(frozen=True, slots=True, kw_only=True)
class InvokeCliSession:
    """Run this turn's Claude CLI session under the Router's id (guuey#3407 B3)."""

    mode: CliSessionMode
    id: str
    expect_last_prompt_sha: str | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {"mode": self.mode, "id": self.id}
        if self.expect_last_prompt_sha is not None:
            out["expectLastPromptSha"] = self.expect_last_prompt_sha
        return out


# -- Router -> Worker: the control stream (fd 0) -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class Invoke:
    """Start a turn, carrying the pushed context. See protocol.ts ``Invoke`` for every member's contract."""

    type: ClassVar[Literal["invoke"]] = "invoke"
    input: str
    input_kind: InputKind | None = None
    identity: Identity
    fs: Fs
    fs_bound: bool | None = None
    history: tuple[HistoryMessage, ...]
    prior_memory: tuple[PriorMemoryRecord, ...] | None = None
    prior_state: JsonValue | Absent = ABSENT
    user_memory: str | None = None
    memory_attached: bool | None = None
    profile_access: ProfileAccess | None = None
    profile_sections: tuple[ProfileSection, ...] | None = None
    first_impression: FirstImpressionPush | None = None
    mcp_availability: tuple[McpAvailability, ...] | None = None
    resource_count: int | None = None
    ggui_attached: bool | None = None
    client_catalogs: tuple[str, ...] | None = None
    withheld_tools: tuple[WithheldTool, ...] | None = None
    first_impression_shown: FirstImpressionShown | None = None
    suspend: InvokeSuspendOffer | None = None
    resume: InvokeResume | None = None
    thread_close: InvokeThreadCloseOffer | None = None
    thread_id: str | None = None
    attachments: tuple[InvokeImageAttachment, ...] | None = None
    cli_session: InvokeCliSession | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {"type": self.type, "input": self.input}
        if self.input_kind is not None:
            out["inputKind"] = self.input_kind
        out["identity"] = self.identity.to_wire()
        out["fs"] = self.fs.to_wire()
        if self.fs_bound is not None:
            out["fsBound"] = self.fs_bound
        out["history"] = [message.to_wire() for message in self.history]
        if self.prior_memory is not None:
            out["priorMemory"] = [record.to_wire() for record in self.prior_memory]
        if not isinstance(self.prior_state, Absent):
            out["priorState"] = self.prior_state
        if self.user_memory is not None:
            out["userMemory"] = self.user_memory
        if self.memory_attached is not None:
            out["memoryAttached"] = self.memory_attached
        if self.profile_access is not None:
            out["profileAccess"] = self.profile_access
        if self.profile_sections is not None:
            out["profileSections"] = [section.to_wire() for section in self.profile_sections]
        if self.first_impression is not None:
            out["firstImpression"] = self.first_impression.to_wire()
        if self.mcp_availability is not None:
            out["mcpAvailability"] = [entry.to_wire() for entry in self.mcp_availability]
        if self.resource_count is not None:
            out["resourceCount"] = self.resource_count
        if self.ggui_attached is not None:
            out["gguiAttached"] = self.ggui_attached
        if self.client_catalogs is not None:
            out["clientCatalogs"] = list(self.client_catalogs)
        if self.withheld_tools is not None:
            out["withheldTools"] = [tool.to_wire() for tool in self.withheld_tools]
        if self.first_impression_shown is not None:
            out["firstImpressionShown"] = self.first_impression_shown.to_wire()
        if self.suspend is not None:
            out["suspend"] = self.suspend.to_wire()
        if self.resume is not None:
            out["resume"] = self.resume.to_wire()
        if self.thread_close is not None:
            out["threadClose"] = self.thread_close.to_wire()
        if self.thread_id is not None:
            out["threadId"] = self.thread_id
        if self.attachments is not None:
            out["attachments"] = [attachment.to_wire() for attachment in self.attachments]
        if self.cli_session is not None:
            out["cliSession"] = self.cli_session.to_wire()
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class Shutdown:
    """Graceful termination (also signalled by stdin EOF)."""

    type: ClassVar[Literal["shutdown"]] = "shutdown"

    def to_wire(self) -> JsonObject:
        return {"type": self.type}


@dataclass(frozen=True, slots=True, kw_only=True)
class UnknownControl:
    """A well-formed control line of a type this release does not know (guuey#3434): skipped, never interpreted."""

    type: ClassVar[Literal["unknown"]] = "unknown"
    raw_type: str

    def to_wire(self) -> JsonObject:
        return {"type": self.type, "rawType": self.raw_type}


type ControlMessage = Invoke | Shutdown | UnknownControl


# -- Worker -> Router: the event stream (fd 3) -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, kw_only=True)
class TextEvent:
    """Stream a chunk of assistant output."""

    type: ClassVar[Literal["text"]] = "text"
    text: str

    def to_wire(self) -> JsonObject:
        return {"type": self.type, "text": self.text}


@dataclass(frozen=True, slots=True, kw_only=True)
class EndThread:
    """A worker's request to end the conversation (rules: :func:`guuey_host.protocol_rules.end_thread_problem`)."""

    code: str
    message: str

    def to_wire(self) -> JsonObject:
        return {"code": self.code, "message": self.message}


@dataclass(frozen=True, slots=True, kw_only=True)
class DoneEvent:
    """Terminal success. ``result`` is the turn's final text."""

    type: ClassVar[Literal["done"]] = "done"
    stop_reason: StopReason
    result: str
    end_thread: EndThread | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {"type": self.type, "stopReason": self.stop_reason, "result": self.result}
        if self.end_thread is not None:
            out["endThread"] = self.end_thread.to_wire()
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class ErrorEvent:
    """Terminal failure."""

    type: ClassVar[Literal["error"]] = "error"
    message: str

    def to_wire(self) -> JsonObject:
        return {"type": self.type, "message": self.message}


@dataclass(frozen=True, slots=True, kw_only=True)
class NativeEvent:
    """Pass-through carrier for one framework-native SDK event; only the Router's normalizer reads ``event``."""

    type: ClassVar[Literal["native"]] = "native"
    framework: str
    event: JsonValue

    def to_wire(self) -> JsonObject:
        return {"type": self.type, "framework": self.framework, "event": self.event}


@dataclass(frozen=True, slots=True, kw_only=True)
class HelloHeaderShas:
    """One sha per agent-configuration field passed to the SDK."""

    model: str
    permission_mode: str
    tools: str
    mcp_config: str

    def to_wire(self) -> JsonObject:
        return {
            "model": self.model,
            "permissionMode": self.permission_mode,
            "tools": self.tools,
            "mcpConfig": self.mcp_config,
        }


@dataclass(frozen=True, slots=True, kw_only=True)
class HelloWalk:
    """One root-to-leaf path of the stored session."""

    from_last_prompt_leaf: bool
    prompt_shas: tuple[str, ...]
    compact_summaries: int
    boundary: WalkBoundary

    def to_wire(self) -> JsonObject:
        return {
            "fromLastPromptLeaf": self.from_last_prompt_leaf,
            "promptShas": list(self.prompt_shas),
            "compactSummaries": self.compact_summaries,
            "boundary": self.boundary,
        }


@dataclass(frozen=True, slots=True, kw_only=True)
class HelloStoredMeasures:
    """What a ``resume`` found in the stored session."""

    read_error: StoredReadError | None = None
    system_prompt_shas: tuple[str, ...]
    walks: tuple[HelloWalk, ...]
    last_prompt_shas: tuple[str, ...]
    session_ids: tuple[str, ...] | None = None
    entries: tuple[str, ...]
    unclassified: int
    corrupt: int
    benign_duplicates: int
    file_prompt_entries: int
    file_compact_summaries: int

    def to_wire(self) -> JsonObject:
        out: JsonObject = {}
        if self.read_error is not None:
            out["readError"] = self.read_error
        out["systemPromptShas"] = list(self.system_prompt_shas)
        out["walks"] = [walk.to_wire() for walk in self.walks]
        out["lastPromptShas"] = list(self.last_prompt_shas)
        if self.session_ids is not None:
            out["sessionIds"] = list(self.session_ids)
        out["entries"] = list(self.entries)
        out["unclassified"] = self.unclassified
        out["corrupt"] = self.corrupt
        out["benignDuplicates"] = self.benign_duplicates
        out["filePromptEntries"] = self.file_prompt_entries
        out["fileCompactSummaries"] = self.file_compact_summaries
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class HelloCliSession:
    """The hello's thread-resume block. Every sha is ``@guuey/host``'s content hash."""

    hash_version: int
    system_prompt_sha256: str
    header_shas: HelloHeaderShas
    prompt_sha: str
    prompt_bytes: int
    last_prompt_sha: str
    stored: HelloStoredMeasures | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {
            "hashVersion": self.hash_version,
            "systemPromptSha256": self.system_prompt_sha256,
            "headerShas": self.header_shas.to_wire(),
            "promptSha": self.prompt_sha,
            "promptBytes": self.prompt_bytes,
            "lastPromptSha": self.last_prompt_sha,
        }
        if self.stored is not None:
            out["stored"] = self.stored.to_wire()
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class WorkerHelloEvent:
    """The SDK-version handshake: emitted at most once per invoke, before any native/turn event."""

    type: ClassVar[Literal["hello"]] = "hello"
    framework: str
    sdk_name: str | None
    sdk_version: str | None
    capabilities: tuple[str, ...] | None = None
    cli_session: HelloCliSession | None = None

    def to_wire(self) -> JsonObject:
        out: JsonObject = {
            "type": self.type,
            "framework": self.framework,
            "sdkName": self.sdk_name,
            "sdkVersion": self.sdk_version,
        }
        if self.capabilities is not None:
            out["capabilities"] = list(self.capabilities)
        if self.cli_session is not None:
            out["cliSession"] = self.cli_session.to_wire()
        return out


@dataclass(frozen=True, slots=True, kw_only=True)
class SuspendEvent:
    """The worker paused on pending asks. Router-plane only; sent only on an invoke that offered ``suspend``."""

    type: ClassVar[Literal["suspend"]] = "suspend"
    envelope: str
    ask_ids: tuple[str, ...]

    def to_wire(self) -> JsonObject:
        return {"type": self.type, "envelope": self.envelope, "askIds": list(self.ask_ids)}


type WorkerEvent = TextEvent | DoneEvent | ErrorEvent | NativeEvent | WorkerHelloEvent | SuspendEvent


@dataclass(frozen=True, slots=True, kw_only=True)
class UnknownEvent:
    """A well-formed event line of a type this release does not know (guuey#3434). NOT a :data:`WorkerEvent`."""

    type: ClassVar[Literal["unknown"]] = "unknown"
    raw_type: str

    def to_wire(self) -> JsonObject:
        return {"type": self.type, "rawType": self.raw_type}


type ParsedEvent = WorkerEvent | UnknownEvent
"""What :func:`guuey_host.parse.read_event` returns: a known event, or an :class:`UnknownEvent`."""


class WorkerProtocolError(ValueError):
    """A malformed protocol line. The JavaScript parser throws a plain ``Error`` with the same message."""

    JS_NAME: ClassVar[str] = "Error"
