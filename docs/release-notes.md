# Decision desktop downloads

Decision is free, open-source software. This release provides two native desktop downloads:

- Windows x64: `Decision-<version>-win-x64-Setup.exe`
- Apple Silicon macOS: `Decision-darwin-arm64-<version>.zip`

Download only from the official `cognelis/decision` GitHub Release. Each application file has an adjacent `.sha256` file and a JSON manifest.

## Windows first run

The Windows installer is unsigned, so Microsoft Defender SmartScreen can show an “Unknown publisher” warning. First compare the installer SHA-256 with its adjacent checksum. If it matches this official Release, choose **More info**, review the displayed filename, and then choose **Run anyway**.

## macOS first run

The macOS application has an ad-hoc signature and is not notarized by Apple, so Gatekeeper can block its first launch. After comparing the ZIP SHA-256, open the app from Finder. If macOS blocks it, open **System Settings → Privacy & Security**, find the Decision message, and choose **Open Anyway**. Do not disable Gatekeeper globally.

## What the checksums mean

SHA-256 checks download integrity: it can reveal a changed or incomplete file. It is not publisher identity verification and does not replace Authenticode, Developer ID signing, or notarization.

Decision does not charge for these downloads and does not update itself automatically. Updates remain a manual download from the official Release. The repository README contains source-build instructions for users who prefer to compile the application themselves.
