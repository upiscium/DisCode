import { DirectoryPolicy, type DirectoryResolver } from "../domain/directory-policy.js";
import { expandHostDirectoryInput } from "../domain/host-directory-input.js";
import type { OpenCodeHostConfig } from "../domain/host-registry.js";
import { createOpenCodeDirectoryResolver } from "./remote-directory-resolver.js";

export function createHostDirectoryAuthorizer(
  host: OpenCodeHostConfig,
  resolveDirectory: DirectoryResolver = createOpenCodeDirectoryResolver(host),
): (directory: string) => Promise<string> {
  let policyPromise: Promise<DirectoryPolicy> | undefined;

  return async (directory: string): Promise<string> => {
    const expandedDirectory = expandHostDirectoryInput(directory, host.homeDirectory);
    if (!policyPromise) {
      policyPromise = DirectoryPolicy.createWithResolver(host.allowedRoots, resolveDirectory).catch(
        (error) => {
          policyPromise = undefined;
          throw error;
        },
      );
    }
    return (await policyPromise).authorize(expandedDirectory);
  };
}
