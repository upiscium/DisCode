{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.opencode-discord-bridge;
  statePath = "/var/lib/${cfg.stateDirectory}/${cfg.stateFile}";
  serviceEnvironment = cfg.environment // {
    OCB_LOG_LEVEL = cfg.logLevel;
    OCB_LOG_FORMAT = cfg.logFormat;
    OCB_METRICS_ENABLED = if cfg.metrics.enable then "true" else "false";
    OCB_METRICS_HOST = cfg.metrics.address;
    OCB_METRICS_PORT = builtins.toString cfg.metrics.port;
  } // lib.optionalAttrs (cfg.secretsFile != null) {
    OCB_SECRETS_FILE = cfg.secretsFile;
  };
in
{
  options.services.opencode-discord-bridge = {
    enable = lib.mkEnableOption "OpenCode Discord Bridge";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.opencode-discord-bridge.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "OpenCode Discord Bridge package to run.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "opencode-discord-bridge";
      description = "User account used by the Bridge service.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "opencode-discord-bridge";
      description = "Group used by the Bridge service.";
    };

    createUser = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether the module should create the configured system user and group.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/opencode-discord-bridge.env";
      description = ''
        Runtime systemd EnvironmentFile containing Bridge configuration. Keep secrets in
        secretsFile when possible. STATE_FILE is controlled by this module and does not
        need to be present in the environment file.
      '';
    };

    secretsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "~/secrets/ocb_secrets.env";
      description = ''
        Optional dotenv-style file containing Bridge secrets. The path is passed to the
        runtime as OCB_SECRETS_FILE; the file content is never read by Nix. '~/' is
        expanded by the Bridge using the service user's home directory at runtime.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        DISCORD_STREAM_ASSISTANT_TEXT = "false";
        DISCORD_SHOW_TOOL_SUMMARIES = "false";
      };
      description = ''
        Non-secret environment variables supplied directly to the service. Values
        declared here are part of the Nix configuration and must not contain tokens,
        passwords, or other secrets.
      '';
    };

    logLevel = lib.mkOption {
      type = lib.types.enum [ "debug" "info" "warn" "error" ];
      default = "info";
      description = "Minimum structured log level emitted by the Bridge.";
    };

    logFormat = lib.mkOption {
      type = lib.types.enum [ "json" "pretty" ];
      default = "json";
      description = "Bridge log format. JSON is the default for systemd/journald operation.";
    };

    metrics = lib.mkOption {
      default = { };
      description = "Optional Prometheus metrics scrape endpoint.";
      type = lib.types.submodule {
        options = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Whether to expose the Bridge metrics HTTP endpoint.";
          };
          address = lib.mkOption {
            type = lib.types.str;
            default = "127.0.0.1";
            description = "Address used by the metrics listener. Loopback is the safe default.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            default = 9464;
            description = "TCP port used by the metrics listener. The module does not open the firewall.";
          };
        };
      };
    };

    stateDirectory = lib.mkOption {
      type = lib.types.strMatching "[A-Za-z0-9_.-]+";
      default = "opencode-discord-bridge";
      description = "systemd StateDirectory name used for persistent Bridge state.";
    };

    stateFile = lib.mkOption {
      type = lib.types.strMatching "[A-Za-z0-9_.-]+";
      default = "state.json";
      description = "State filename stored inside the service StateDirectory.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          cfg.environmentFile == null
          || !lib.hasPrefix builtins.storeDir cfg.environmentFile;
        message = "services.opencode-discord-bridge.environmentFile must point outside the Nix store";
      }
      {
        assertion =
          cfg.secretsFile == null
          || !lib.hasPrefix builtins.storeDir cfg.secretsFile;
        message = "services.opencode-discord-bridge.secretsFile must point outside the Nix store";
      }
    ];

    users.groups = lib.mkIf cfg.createUser {
      "${cfg.group}" = { };
    };

    users.users = lib.mkIf cfg.createUser {
      "${cfg.user}" = {
        isSystemUser = true;
        group = cfg.group;
      };
    };

    systemd.services.opencode-discord-bridge = {
      description = "OpenCode Discord Bridge";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = serviceEnvironment;

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        ExecStart = "${pkgs.coreutils}/bin/env STATE_FILE=${statePath} ${lib.getExe cfg.package}";
        WorkingDirectory = "/var/lib/${cfg.stateDirectory}";
        StateDirectory = cfg.stateDirectory;
        StateDirectoryMode = "0750";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = "5s";
        KillSignal = "SIGTERM";
        TimeoutStopSec = "30s";
      } // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };
  };
}
