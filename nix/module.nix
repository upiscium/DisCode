{ self }:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.opencode-discord-bridge;
  statePath = "/var/lib/${cfg.stateDirectory}/${cfg.stateFile}";
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
      example = "/run/secrets/opencode-discord-bridge.env";
      description = ''
        Runtime systemd EnvironmentFile containing Bridge configuration and secrets.
        Use a path outside the Nix store. STATE_FILE is controlled by this module and
        does not need to be present in the environment file.
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

      environment = cfg.environment;

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
