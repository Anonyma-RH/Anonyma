# Code & Build

**Public source release kit · September 24, 2026**

An idea. A prompt. A project.

Code & Build provides a dedicated code workspace, generated files beside the
conversation, and a ZIP download of the project. The implementation is included
in this public repository; this commit adds its public announcement film and
release notes. It does not represent the original implementation date.

[![Code & Build film](../assets/releases/code-and-build.png)](../assets/releases/code-and-build.mp4)

[Download the 14-second announcement film](../assets/releases/code-and-build.mp4)

## Try the source locally

Follow the [local setup](../../README.md#run-locally), then set
`RELEASED_FEATURES=mvp,code` in your local `.env` and restart the development
server. The Code workspace exposes files extracted from generated responses
and can download them as a ZIP. Local test mode uses simulated responses; real
model generation requires your own provider access.

## Hosted availability and limitations

The hosted app is still on its small MVP. Code & Build remains gated there;
its hosted rollout will be announced separately. Public source availability
is not a claim that every feature is live at askanonyma.com.

Generated files are not executed in a sandbox by this workspace. Review and test
generated code before running it. ZIP export packages the generated files and
does not verify that a project builds successfully.

## Video validation

The announcement film is 1920×1080, 30 fps, H.264 with stereo AAC audio. Its
text was checked with Tesseract at keyframes and through a 42-frame sweep.
It contains no “Live now” claim or numbered update title. Its end card says
“Explore the code” and “Hosted feature release coming soon”.

Docs and original artwork: CC BY-NC 4.0. Code: PolyForm Noncommercial 1.0.0.
See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
