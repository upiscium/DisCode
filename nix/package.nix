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

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save --offline

    runtimeDir="$out/lib/opencode-discord-bridge"
    mkdir -p "$runtimeDir" "$out/bin"
    cp -r dist "$runtimeDir/dist"
    cp package.json "$runtimeDir/package.json"
    cp -r node_modules "$runtimeDir/node_modules"

    makeWrapper ${nodejs_22}/bin/node "$out/bin/opencode-discord-bridge" \
      --add-flags "$runtimeDir/dist/index.js"

    runHook postInstall
  '';

  meta = {
    description = packageJson.description;
    mainProgram = "opencode-discord-bridge";
    platforms = lib.platforms.linux;
  };
}
