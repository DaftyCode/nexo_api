cask "nexo-api" do
  version "0.2.0"

  on_arm do
    sha256 "ee53cc78bf7529c9bd6111dea7d361b4e9d52ab74e3928470ca5f332029d4e43"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.2.0/Nexo.API_0.2.0_aarch64.dmg"
  end

  on_intel do
    sha256 "8cbbacbd2dee7126f4d0add2a36f187862d936a584da82fa17228398ad4755d0"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.2.0/Nexo.API_0.2.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
