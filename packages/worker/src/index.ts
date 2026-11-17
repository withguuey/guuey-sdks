/**
 * @guuey/worker — Guuey Worker Protocol v1 types + the tiered worker SDK.
 * See docs/superpowers/specs/2026-06-22-worker-platform-northstar-design.md §1.
 */
export {
  PROTOCOL_VERSION,
  ADK_HOST_COMPLETION_CAPABILITY,
  HOST_SUSPEND_CAPABILITY,
  TOOL_GATES_CAPABILITY,
  CLI_SESSION_CAPABILITY,
  CLI_SESSION_HASH_VERSION,
  CLI_SESSION_RESUME_FAILED,
  SDK_SESSION_CAPABILITY,
  SDK_SESSION_HASH_VERSION,
  SDK_SESSION_PROMPT_SHAS_MAX,
  SDK_SESSION_IDS_MAX,
  type InvokeCliSession,
  type HelloCliSession,
  type HelloHeaderShas,
  type HelloStoredMeasures,
  type HelloWalk,
  type SdkSessionKind,
  type HelloSdkSession,
  type HelloSdkHeaderShas,
  type HelloSdkStored,
  INVOKE_IMAGES_CAPABILITY,
  INVOKE_IMAGE_MIME_TYPES,
  SUSPEND_ENVELOPE_MAX_BYTES,
  type ProtocolVersion,
  type JsonValue,
  type AuthMode,
  type Identity,
  type Fs,
  type HistoryMessage,
  type PriorMemoryRecord,
  type ProfileSection,
  type FirstImpressionPush,
  type WithheldTool,
  type FirstImpressionShown,
  type McpAvailability,
  type McpAvailabilityState,
  type StopReason,
  type Invoke,
  type InvokeImageAttachment,
  type InvokeImageMimeType,
  type InvokeSuspendOffer,
  type InvokeResume,
  type InvokeThreadCloseOffer,
  type EndThread,
  type ResumeAnswer,
  type ResumeAnswerStatus,
  type Shutdown,
  type UnknownControl,
  type ControlMessage,
  type TextEvent,
  type DoneEvent,
  type ErrorEvent,
  type NativeEvent,
  type WorkerHelloEvent,
  type SuspendEvent,
  type WorkerEvent,
  type UnknownEvent,
  type ParsedEvent,
} from "./protocol.js";
export {
  parseControl,
  readEvent,
  isInvoke,
  isShutdown,
  isUnknownControl,
  isUnknownEvent,
  isText,
  isDone,
  isError,
  isNative,
  isHello,
  isSuspend,
} from "./parse.js";
export { INPUT_KINDS, type InputKind, isInputKind, inputKindCapability } from "./protocol.js";
export { compareStoredSession, type CliSessionRecord, type CliSessionRefusal, type CliSessionVerdict } from "./cli-session-compare.js";
// guuey#3550: thread resume for a Claude CLI turn. ONE sequence, run by @guuey/host's Claude framework and by a builder
// worker (serveNative's claudeSession), so both sides of the Router's compare hash alike. Public on purpose, and kept
// small: the sequence, its id check, its refusal texts, the config-root variable's name, the types a builder's turn
// names, and the three content hashes a caller's tests compare against. The measure, the canonical forms and the gate
// stay internal.
export { hashSystemPrompt, hashUserBlocks, hashUserText } from "./cli-session-hash.js";
export {
  CLI_SESSION_CWD_MISSING,
  CLI_SESSION_NO_OWN_TEXT,
  CLI_SESSION_PATH_TOO_LONG,
  type ClaudeSessionHeader,
  type ClaudeSessionServer,
} from "./claude-session-block.js";
export {
  CLAUDE_CLI_CONFIG_DIR_ENV,
  CLI_SESSION_ID_NOT_UUID,
  CLI_SESSION_PROMPT_NOT_STRING,
  applyClaudeSession,
  cliSessionIdProblem,
  cliSessionNotAppliedMessage,
  type AppliedClaudeSession,
  type ClaudeSessionMessage,
  type ClaudeSessionTurn,
  type WorkerClaudeSession,
  type WorkerClaudeSessionTurn,
} from "./claude-session.js";
export { CONTEXT_ONLY_TURN_TEXT, MODEL_TEXT_INPUT_KIND_CAPABILITIES, modelInputOf, modelTextOf } from "./model-text.js";
export { invokeImagesCapabilities, isInvokeImageMimeType, isStandardBase64 } from "./images.js";
export {
  anthropicUserContent,
  geminiUserParts,
  openaiTurnInput,
  type AnthropicUserBlock,
  type GeminiPart,
  type ImageTurn,
  type OpenAiUserPart,
} from "./image-parts.js";
export {
  TURN_IMAGES_DIR,
  TURN_IMAGES_FACES,
  TURN_IMAGES_MAX,
  TURN_IMAGE_MAX_BYTES,
  TurnImagesError,
  attachmentFileName,
  saveTurnImages,
  storeTurnImages,
  type StoredTurnImage,
  type TurnImagesProblem,
} from "./turn-images-store.js";
export { createEmitter, type Emitter, type WriteSink } from "./emit.js";
export { endThreadProblem, END_THREAD_CODE_PATTERN, END_THREAD_MESSAGE_MAX_CHARS } from "./end-thread.js";
export {
  parseClientCatalogs,
  CLIENT_CATALOGS_MAX,
  CLIENT_CATALOG_ID_MAX_CHARS,
  CLIENT_CATALOG_ID_PATTERN,
} from "./client-catalogs.js";
export { createSuspendWriter, type SuspendWriter, type SuspendWriteResult } from "./suspend-writer.js";
export { listCredentials, MCP_SERVERS_FILE_ENV, type CredentialFile, type McpServersFile } from "./creds.js";
export { serve, serveOn, type ServeOptions } from "./serve.js";
export { Turn, type WorkerHandler } from "./turn.js";
export { serveNative, serveNativeOn } from "./serve-native.js";
export type { NativeEmit, NativeHandler, NativeServeInfo } from "./serve-native.js";
export { mcpToolCustomData, type McpToolCustomData, type McpToolCustomDataContext } from "./mcp-custom-data.js";
export {
  modelMayCallTool,
  modelVisibleToolFilter,
  modelVisibleToolFilterFor,
  modelVisibleToolFilterWith,
} from "./mcp-visibility.js";
export { withheldToolNamesFor } from "./withheld-tools.js";
export {
  LAUNCH_ENVELOPE_FD,
  LAUNCH_ENVELOPE_FD_ENV,
  LAUNCH_ENVELOPE_VERSION,
  LAUNCH_ENVELOPE_MAX_BYTES,
  LAUNCH_ENVELOPE_DEADLINE_MS,
  LaunchEnvelopeError,
  encodeLaunchEnvelope,
  parseLaunchEnvelope,
  readLaunchEnvelope,
  type LaunchEnvelope,
  type LaunchModelCapability,
  type LaunchWire,
  type ReadLaunchEnvelopeOptions,
} from "./launch-envelope.js";
export {
  CLAUDE_AUTH_PATH_ENV,
  CLAUDE_CLI_FIXED_ROOT,
  CLAUDE_CLI_ROOT_ENV,
  CLAUDE_CREDENTIAL_ENV,
  CLAUDE_FORBIDDEN_ENV,
  CLAUDE_HOST_OWNED_ENV,
  CLAUDE_KEY_FD,
  CLAUDE_CODE_EXECUTABLE_ENV,
  CLAUDE_KEY_FD_ENV,
  CLAUDE_OAUTH_FD_ENV,
  ClaudeSpawnRefusedError,
  INSPECTOR_ENV,
  PLATFORM_TRUST_ENV_NAMES,
  claudeCodeExecutableOf,
  forbiddenClaudeEnvNames,
  isClaudeHostOwnedEnvName,
  makeClaudeSpawner,
  redactSecrets,
  secretForms,
  trustEnvOf,
  type ClaudeKeyKind,
  type ClaudeSpawnRequest,
  type ClaudeSpawnedProcess,
  type ClaudeSpawnerOptions,
} from "./claude-spawn.js";
