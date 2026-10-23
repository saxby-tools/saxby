# Template. The release workflow fills in @VERSION@ and the
# @SHA256_*@ checksums and attaches the result to the release, so
# this file is never edited by hand per release.
#
# Keeps a service block, as Homebrew formulae do. `brew services` and
# `shunt service install` are two supervisors for one port; running
# both is user error, and the second one to start says so loudly.
class Shuntd < Formula
  BASE = "https://github.com/shuntd-dev/shuntd/releases/download".freeze

  desc "Local-first LLM routing daemon"
  homepage "https://github.com/shuntd-dev/shuntd"
  version "@VERSION@"
  license "AGPL-3.0-or-later"

  on_macos do
    on_arm do
      url "#{BASE}/v@VERSION@/shuntd-@VERSION@-darwin-arm64.tar.gz"
      sha256 "@SHA256_DARWIN_ARM64@"
    end

    on_intel do
      url "#{BASE}/v@VERSION@/shuntd-@VERSION@-darwin-x64.tar.gz"
      sha256 "@SHA256_DARWIN_X64@"
    end
  end

  on_linux do
    on_arm do
      url "#{BASE}/v@VERSION@/shuntd-@VERSION@-linux-arm64.tar.gz"
      sha256 "@SHA256_LINUX_ARM64@"
    end

    on_intel do
      url "#{BASE}/v@VERSION@/shuntd-@VERSION@-linux-x64.tar.gz"
      sha256 "@SHA256_LINUX_X64@"
    end
  end

  def install
    bin.install "shuntd", "shunt"
  end

  service do
    run [opt_bin/"shuntd"]
    keep_alive true
    log_path var/"log/shuntd.log"
    error_log_path var/"log/shuntd.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/shunt --version")
  end
end
