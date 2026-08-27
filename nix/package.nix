{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeWrapper,
  nodejs_22,
}:

let
  packageJson = lib.importJSON ../package.json;
in
buildNpmPackage {
  pname = packageJson.name;
  version = packageJson.version;

  src = lib.cleanSource ../.;
  nodejs = nodejs_22;

  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  npmBuildScript = "build";

  nativeBuildInputs = [ makeWrapper ];

  postInstall = ''
    mkdir -p "$out/bin"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/opencode-discord-bridge" \
      --add-flags "$out/lib/node_modules/${packageJson.name}/dist/index.js"
  '';

  meta = {
    description = packageJson.description;
    mainProgram = "opencode-discord-bridge";
    platforms = lib.platforms.linux;
  };
}
