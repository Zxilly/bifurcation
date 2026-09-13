import "server-only";
import type { ServiceImpl } from "@connectrpc/connect";
import { AdminConfigurationService, type MachineConfigurationInput as ProtoSettings } from "@bifurcation/rpc/panel/configuration";
import { ConfigurationStore } from "@/server/configuration/store";
import { panelCall, requirePrincipal } from "./common";
import { toProtoConfiguration, toProtoPreview, toProtoTask } from "./mappers";

// Converts the wire shape back into the discriminated union the domain
// validator expects; validation itself stays in the configuration store.
function settingsFromProto(settings: ProtoSettings | undefined) {
  if (settings === undefined) return undefined;
  const tls = settings.tls;
  const mode = tls?.mode.case;
  return {
    listen: settings.listen,
    trojanPort: settings.trojanPort,
    hysteria2Port: settings.hysteria2Port,
    tls:
      tls === undefined || mode === undefined
        ? undefined
        : mode === "pem"
          ? { mode, serverName: tls.serverName, certificatePem: tls.mode.value.certificatePem, privateKeyPem: tls.mode.value.privateKeyPem }
          : mode === "path"
            ? { mode, serverName: tls.serverName, certificatePath: tls.mode.value.certificatePath, privateKeyPath: tls.mode.value.privateKeyPath }
            : { mode, serverName: tls.serverName, email: tls.mode.value.email },
    baseJson: settings.baseJson ?? {},
  };
}

export const configurationImplementation: ServiceImpl<typeof AdminConfigurationService> = {
  getMachineConfiguration(request) {
    return panelCall(() => ({ configuration: toProtoConfiguration(new ConfigurationStore().get(request.machineId)) }));
  },

  previewConfiguration(request, context) {
    return panelCall(async () => ({
      preview: toProtoPreview(
        await new ConfigurationStore().preview(
          request.machineId,
          { expectedVersion: request.expectedVersion, settings: settingsFromProto(request.settings) },
          requirePrincipal(context).user.id,
        ),
      ),
    }));
  },

  publishConfiguration(request, context) {
    return panelCall(async () => {
      const result = await new ConfigurationStore().publish(
        request.machineId,
        {
          previewId: request.previewId,
          expectedVersion: request.expectedVersion,
          requestKey: request.requestKey,
        },
        requirePrincipal(context).user.id,
      );
      return { revisionId: result.revisionId, version: result.version, task: toProtoTask(result.task) };
    });
  },
};
