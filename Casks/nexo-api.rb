cask "nexo-api" do
  version "0.8.0"

  on_arm do
    sha256 "42339171836c6495fed682e00a4dd6eec98da99291ea0a892324bafb2d6bac27"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.8.0/Nexo.API_0.8.0_aarch64.dmg"
  end

  on_intel do
    sha256 "35c343ae83f4bd98136b240bc78fda55d116767e99c34af4643721bfdd7dcf6e"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.8.0/Nexo.API_0.8.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
