/**
 * guuey dev -- STUBBED for slice 1 cleanup.
 *
 * The local agent-dev experience is being rebuilt as an Expo-style flow:
 * `guuey dev` will boot the local agent + open an outbound WebSocket to
 * the eks-bridge-gateway pod + print a QR code; portal scans the QR and
 * routes end-user traffic through the bridge to the developer's local
 * agent (slice 2+).
 *
 * The previous implementation booted a local agent-server and portal
 * dev surface — both of which depended on the ggui-render pipeline
 * that was retired in slice 1. Falling back to a clear "rebuild
 * coming" exit instead of running broken plumbing.
 */
import * as out from "../output";

export async function dev(_flags?: Record<string, string | true>): Promise<void> {
  out.error(
    "guuey dev is being rebuilt as an Expo-style bridge + QR flow (slice 2+).\n" +
      "  In the meantime, deploy with `guuey deploy` and iterate against the\n" +
      "  live endpoint at https://platform.guuey.com.",
  );
  process.exit(1);
}
