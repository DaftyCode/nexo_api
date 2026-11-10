cask "nexo-api" do
  version "0.5.0"

  on_arm do
    sha256 "6b2912e4104f45fb8c7a529f7864b59548aff6f07bc912cdc419c23ecfed75ac"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.5.0/Nexo.API_0.5.0_aarch64.dmg"
  end

  on_intel do
    sha256 "80a24f1ea98ff82ef63ed8f7c6b74f9f1173505c77bf9f80788e75dffe124160"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.5.0/Nexo.API_0.5.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
