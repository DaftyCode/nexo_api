cask "nexo-api" do
  version "0.3.0"

  on_arm do
    sha256 "7518efd14847d953ba905332d2f8d9c4e538fb026d705216aa022958d5e08d86"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.3.0/Nexo.API_0.3.0_aarch64.dmg"
  end

  on_intel do
    sha256 "bd8ade7a14062be4db9243af89c7b9243af1c4912155fbee52f3ec37e41be228"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.3.0/Nexo.API_0.3.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
