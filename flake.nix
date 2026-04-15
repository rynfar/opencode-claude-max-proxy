{
  description = "Meridian – Local Anthropic API powered by your Claude Max subscription";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix = {
      url = "github:nix-community/bun2nix?tag=2.0.8";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      systems,
      bun2nix,
    }:
    let
      eachSystem = nixpkgs.lib.genAttrs (import systems);
      pkgsFor = eachSystem (
        system:
        import nixpkgs {
          inherit system;
          overlays = [ bun2nix.overlays.default ];
        }
      );
    in
    {
      packages = eachSystem (
        system:
        let
          pkgs = pkgsFor.${system};
        in
        {
          meridian = pkgs.stdenvNoCC.mkDerivation {
            pname = "meridian";
            version =
              (builtins.fromJSON (builtins.readFile ./package.json)).version;

            src = pkgs.lib.cleanSource ./.;

            nativeBuildInputs = [
              pkgs.bun2nix.hook
              pkgs.bun
              pkgs.nodejs_22
              pkgs.makeWrapper
            ];

            bunDeps = pkgs.bun2nix.fetchBunDeps {
              bunNix = ./bun.nix;
            };

            bunInstallFlags = [ "--linker=hoisted" ];

            buildPhase = ''
              runHook preBuild

              bun build bin/cli.ts src/proxy/server.ts \
                --outdir dist \
                --target node \
                --splitting \
                --external @anthropic-ai/claude-agent-sdk \
                --entry-naming '[name].js'
              node node_modules/typescript/bin/tsc -p tsconfig.build.json

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/meridian
              cp -r dist $out/lib/meridian/
              cp -r node_modules $out/lib/meridian/
              cp package.json $out/lib/meridian/

              mkdir -p $out/bin
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/meridian \
                --add-flags "$out/lib/meridian/dist/cli.js"

              runHook postInstall
            '';

            dontFixup = true;

            meta = {
              description = "Local Anthropic API powered by your Claude Max subscription";
              homepage = "https://github.com/rynfar/meridian";
              license = pkgs.lib.licenses.mit;
              mainProgram = "meridian";
            };
          };

          default = self.packages.${system}.meridian;
        }
      );

      overlays.default = final: prev: {
        meridian = self.packages.${final.system}.meridian;
      };
    };
}
