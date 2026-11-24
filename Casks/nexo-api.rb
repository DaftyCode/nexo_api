cask "nexo-api" do
  version "0.11.0"

  on_arm do
    sha256 "f5d19f778f05ea5535fe54ed33331aab2a3f385510f923133b558d6d7ed4f571"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.11.0/Nexo.API_0.11.0_aarch64.dmg"
  end

  on_intel do
    sha256 "34522ebc3987657d5c09f0b34353ec7992ad5632eb358b9389d84a397bafccd7"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.11.0/Nexo.API_0.11.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
