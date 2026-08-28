{
  description = "OpenCode Discord Bridge";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems f;
      packageFor = system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.callPackage ./nix/package.nix { };
    in
    {
      packages = forAllSystems (system: {
        default = packageFor system;
        opencode-discord-bridge = packageFor system;
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/opencode-discord-bridge";
        };
      });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs_22
              git
              just
              tmux
            ];
          };
        });

      nixosModules.default = import ./nix/module.nix { inherit self; };
      nixosModules.opencode-discord-bridge = self.nixosModules.default;

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          package = self.packages.${system}.default;
          testSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                system.stateVersion = "26.05";
                services.opencode-discord-bridge = {
                  enable = true;
                  package = package;
                  environmentFile = "/run/opencode-discord-bridge.env";
                  secretsFile = "~/secrets/ocb_secrets.env";
                  logLevel = "warn";
                  logFormat = "json";
                  metrics = {
                    enable = true;
                    address = "127.0.0.1";
                    port = 19464;
                  };
                  stateDirectory = "opencode-discord-bridge-test";
                  stateFile = "bindings.json";
                };
              }
            ];
          };
          service = testSystem.config.systemd.services.opencode-discord-bridge;
          credentialSource = "/run/secrets/opencode-discord-bridge.env";
          credentialSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                system.stateVersion = "26.05";
                services.opencode-discord-bridge = {
                  enable = true;
                  package = package;
                  secretsCredentialFile = credentialSource;
                };
              }
            ];
          };
          credentialService = credentialSystem.config.systemd.services.opencode-discord-bridge;
          defaultMetricsSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                system.stateVersion = "26.05";
                services.opencode-discord-bridge = {
                  enable = true;
                  package = package;
                };
              }
            ];
          };
          defaultMetricsService = defaultMetricsSystem.config.systemd.services.opencode-discord-bridge;
          conflictSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                system.stateVersion = "26.05";
                services.opencode-discord-bridge = {
                  enable = true;
                  package = package;
                  secretsFile = "/run/legacy-secrets.env";
                  secretsCredentialFile = credentialSource;
                };
              }
            ];
          };
          storeCredentialSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                system.stateVersion = "26.05";
                services.opencode-discord-bridge = {
                  enable = true;
                  package = package;
                  secretsCredentialFile = "${package}/ocb-secrets.env";
                };
              }
            ];
          };
          relativeCredentialSystem = nixpkgs.lib.nixosSystem {
            inherit system;
            modules = [
              self.nixosModules.default
              {
                system.stateVersion = "26.05";
                services.opencode-discord-bridge = {
                  enable = true;
                  package = package;
                  secretsCredentialFile = "relative/ocb-secrets.env";
                };
              }
            ];
          };
          conflictEval = builtins.tryEval conflictSystem.config.system.build.toplevel;
          storeCredentialEval = builtins.tryEval storeCredentialSystem.config.system.build.toplevel;
          relativeCredentialEval = builtins.tryEval relativeCredentialSystem.config.system.build.toplevel;
          moduleEvalCheck =
            assert service.serviceConfig.Restart == "on-failure";
            assert service.serviceConfig.StateDirectory == "opencode-discord-bridge-test";
            assert service.serviceConfig.EnvironmentFile == "/run/opencode-discord-bridge.env";
            assert service.environment.OCB_SECRETS_FILE == "~/secrets/ocb_secrets.env";
            assert service.environment.OCB_LOG_LEVEL == "warn";
            assert service.environment.OCB_LOG_FORMAT == "json";
            assert service.environment.OCB_METRICS_ENABLED == "true";
            assert service.environment.OCB_METRICS_HOST == "127.0.0.1";
            assert service.environment.OCB_METRICS_PORT == "19464";
            assert !(builtins.elem 19464 testSystem.config.networking.firewall.allowedTCPPorts);
            assert credentialService.serviceConfig.LoadCredential == [ "ocb-secrets.env:${credentialSource}" ];
            assert credentialService.environment.OCB_SECRETS_FILE == "%d/ocb-secrets.env";
            assert credentialService.environment.OCB_SECRETS_FILE != credentialSource;
            assert !nixpkgs.lib.hasInfix credentialSource credentialService.serviceConfig.ExecStart;
            assert !(defaultMetricsService.serviceConfig ? LoadCredential) || defaultMetricsService.serviceConfig.LoadCredential == [ ];
            assert !conflictEval.success;
            assert !storeCredentialEval.success;
            assert !relativeCredentialEval.success;
            assert defaultMetricsService.environment.OCB_METRICS_ENABLED == "false";
            assert defaultMetricsService.environment.OCB_METRICS_HOST == "127.0.0.1";
            assert defaultMetricsService.environment.OCB_METRICS_PORT == "9464";
            assert builtins.elem "network-online.target" service.after;
            assert nixpkgs.lib.hasInfix "STATE_FILE=/var/lib/opencode-discord-bridge-test/bindings.json" service.serviceConfig.ExecStart;
            assert !nixpkgs.lib.hasInfix "DISCORD_TOKEN" service.serviceConfig.ExecStart;
            pkgs.runCommand "opencode-discord-bridge-module-eval" { } ''
              touch "$out"
            '';
        in
        {
          package = package;
          module-eval = moduleEvalCheck;
          entrypoint = pkgs.runCommand "opencode-discord-bridge-entrypoint" { } ''
            test -x ${package}/bin/opencode-discord-bridge
            test -f ${package}/lib/opencode-discord-bridge/dist/index.js
            test -d ${package}/lib/opencode-discord-bridge/node_modules
            touch "$out"
          '';
        });
    };
}
