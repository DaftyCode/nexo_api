cask "nexo-api" do
  version "0.1.0"

  on_arm do
    sha256 "33114ea5e1f53f4cf6a76de7e45c1072b772b9deb29c287cabbeaac4411f60a6"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.1.0/Nexo.API_0.1.0_aarch64.dmg"
  end

  on_intel do
    sha256 "ece1747f9e71771e6b7a9e566d26f1953aec6075ee6a2854ed44b7c9418f2a8d"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.1.0/Nexo.API_0.1.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
