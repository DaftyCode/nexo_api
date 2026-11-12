cask "nexo-api" do
  version "0.6.0"

  on_arm do
    sha256 "afa9921f392883a017c8a7dce253851eebd444ab9f696837308a12010d7d09f4"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.6.0/Nexo.API_0.6.0_aarch64.dmg"
  end

  on_intel do
    sha256 "bd8dfec1eb9c8e624bc85373108d1a531e95754512ea62cc069d6da918a28052"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.6.0/Nexo.API_0.6.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
