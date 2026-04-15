{ meridianPackages }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.meridian;
  pkg = cfg.package;
in
{
  options.services.meridian = {
    enable = lib.mkEnableOption "Meridian proxy service";

    package = lib.mkOption {
      type = lib.types.package;
      default = meridianPackages.${pkgs.system}.meridian;
      description = "The Meridian package to use.";
    };

    settings = {
      port = lib.mkOption {
        type = lib.types.port;
        default = 3456;
        description = "Port to listen on.";
      };

      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = "Host to bind to.";
      };

      idleTimeoutSeconds = lib.mkOption {
        type = lib.types.int;
        default = 120;
        description = "HTTP keep-alive idle timeout in seconds.";
      };

      passthrough = lib.mkOption {
        type = lib.types.nullOr lib.types.bool;
        default = null;
        description = "Forward tool calls to client instead of executing. Null lets Meridian auto-detect.";
      };

      defaultAgent = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Default adapter for unrecognized agents (opencode, forgecode, pi, crush, droid, passthrough).";
      };

      sonnetModel = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Sonnet context tier: 'sonnet' (200k) or 'sonnet[1m]' (1M, requires Extra Usage).";
      };

      telemetry = {
        persist = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Enable SQLite telemetry persistence.";
        };

        retentionDays = lib.mkOption {
          type = lib.types.nullOr lib.types.int;
          default = null;
          description = "Days to retain telemetry data before cleanup.";
        };
      };
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Extra environment variables passed to the Meridian service.";
    };

    opencode.pluginPath = lib.mkOption {
      type = lib.types.str;
      default = "${pkg}/lib/meridian/plugin/meridian.ts";
      readOnly = true;
      description = "Nix store path to the OpenCode plugin file. Use this to reference the plugin in your OpenCode config.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ pkg ];

    systemd.user.services.meridian = {
      Unit = {
        Description = "Meridian - Local Anthropic API proxy";
        After = [ "network.target" ];
      };

      Service = {
        Type = "simple";
        ExecStart = "${pkg}/bin/meridian";
        Restart = "on-failure";
        RestartSec = 5;

        Environment =
          let
            env =
              {
                MERIDIAN_PORT = toString cfg.settings.port;
                MERIDIAN_HOST = cfg.settings.host;
                MERIDIAN_IDLE_TIMEOUT_SECONDS = toString cfg.settings.idleTimeoutSeconds;
              }
              // lib.optionalAttrs (cfg.settings.passthrough != null) {
                MERIDIAN_PASSTHROUGH = if cfg.settings.passthrough then "1" else "0";
              }
              // lib.optionalAttrs (cfg.settings.defaultAgent != null) {
                MERIDIAN_DEFAULT_AGENT = cfg.settings.defaultAgent;
              }
              // lib.optionalAttrs (cfg.settings.sonnetModel != null) {
                MERIDIAN_SONNET_MODEL = cfg.settings.sonnetModel;
              }
              // lib.optionalAttrs cfg.settings.telemetry.persist {
                MERIDIAN_TELEMETRY_PERSIST = "1";
              }
              // lib.optionalAttrs (cfg.settings.telemetry.retentionDays != null) {
                MERIDIAN_TELEMETRY_RETENTION_DAYS = toString cfg.settings.telemetry.retentionDays;
              }
              // cfg.environment;
          in
          lib.mapAttrsToList (k: v: "${k}=${v}") env;
      };

      Install = {
        WantedBy = [ "default.target" ];
      };
    };
  };
}
