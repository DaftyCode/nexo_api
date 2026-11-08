cask "nexo-api" do
  version "0.4.0"

  on_arm do
    sha256 "cb3a3d635d86f8ac9d91542b12062b69c3b7f7394eb793ba97f1b4366a74fdea"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.4.0/Nexo.API_0.4.0_aarch64.dmg"
  end

  on_intel do
    sha256 "8f950928e81c820650d63aef94c8b1756a87e3405b7fb91f58402be9df5342b5"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.4.0/Nexo.API_0.4.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
