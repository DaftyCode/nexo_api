cask "nexo-api" do
  version "0.10.0"

  on_arm do
    sha256 "beb11b4d28ee93b7a56f1bea727da918f6ead441a2c460b30863cf2786f6a222"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.10.0/Nexo.API_0.10.0_aarch64.dmg"
  end

  on_intel do
    sha256 "551970255a4da9825564cd75caf471318b286942fa47c41de0e575ff7cd650c1"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.10.0/Nexo.API_0.10.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
