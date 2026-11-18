cask "nexo-api" do
  version "0.9.0"

  on_arm do
    sha256 "cedfeee3f068ede862326ba455d9159a1bacedf0a86cfdeb484cbb5c88976c8e"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.9.0/Nexo.API_0.9.0_aarch64.dmg"
  end

  on_intel do
    sha256 "b57207b0a8f5ab49c35183d477a9780d3cdc8093bd14a377f0d8e14c21e797c0"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.9.0/Nexo.API_0.9.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
