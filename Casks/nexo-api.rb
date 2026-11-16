cask "nexo-api" do
  version "0.7.0"

  on_arm do
    sha256 "796169571130e32a5c5939cb0a06d12d382e5d5e617005ca39e5a561efbd1932"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.7.0/Nexo.API_0.7.0_aarch64.dmg"
  end

  on_intel do
    sha256 "d2aace0f1995ec1547a560c55eef35d04b47f683837b8bd48b62e098092a199f"
    url "https://github.com/DaftyCode/nexo_api/releases/download/v0.7.0/Nexo.API_0.7.0_x64.dmg"
  end

  name "Nexo API"
  desc "Open source API workspace for desktop and self-hosted servers"
  homepage "https://github.com/DaftyCode/nexo_api"

  depends_on :macos
  app "Nexo API.app"
end
