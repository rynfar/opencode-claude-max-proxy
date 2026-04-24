{
  description = "Meridian – Local Anthropic API powered by your Claude Max subscription";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
    bun2nix = {
      url = "github:nix-community/bun2nix/2.0.8";
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
              bun run build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/meridian
              cp -r dist $out/lib/meridian/
              cp -r node_modules $out/lib/meridian/
              cp -r plugin $out/lib/meridian/
              cp package.json $out/lib/meridian/

              mkdir -p $out/bin
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/meridian \
                --add-flags "$out/lib/meridian/dist/cli.js"

              runHook postInstall
            '';

            # The dist/ output is pre-bundled JS run by node via a wrapper; there
            # are no native binaries or shebangs that need patching. Skipping
            # fixup also avoids unnecessary work on a large node_modules tree.
            dontFixup = true;

            meta = {
              description = "Local Anthropic API powered by your Claude Max subscription";
              homepage = "https://github.com/rynfar/meridian";
              license = pkgs.lib.licenses.mit;
              mainProgram = "meridian";
              platforms = pkgs.lib.platforms.unix;
            };
          };

          default = self.packages.${system}.meridian;
        }
      );

      overlays.default = final: prev: {
        meridian = self.packages.${final.system}.meridian;
      };

      homeManagerModules.default = import ./nix/hm-module.nix {
        meridianPackages = self.packages;
      };
    };
}
