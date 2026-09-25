import React from "react";
import { CopyButton } from "./ui.jsx";
import { featureEnabled } from "./release-copy.js";

// Copyable curl examples for the /v1 media endpoints, shown on the
// Developers page once the v1media update is released. Each endpoint needs
// api + v1media + its studio (server/releases.js featuresFor), so an example
// shows only when its studio is live too. Placeholder model ids match the
// style of the chat-completions example; the host is the site's own origin.
const examples = (origin) => [
  {
    studio: "images",
    label: "IMAGES",
    text: `curl ${origin}/v1/images/generations \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"YOUR_IMAGE_MODEL_ID","prompt":"A cobalt blue paper airplane","n":1}'`,
  },
  {
    studio: "audio",
    label: "TEXT TO SPEECH",
    text: `curl ${origin}/v1/audio/speech \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"YOUR_VOICE_MODEL_ID","input":"Hello from Anonyma."}' \\\n  --output speech.mp3`,
  },
  {
    studio: "audio",
    label: "TRANSCRIPTION",
    text: `curl ${origin}/v1/audio/transcriptions \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -F "file=@speech.mp3;type=audio/mpeg" \\\n  -F "model=YOUR_TRANSCRIPTION_MODEL_ID"`,
  },
];
export default function V1Media({ config }) {
  const shown = examples(window.location.origin).filter((e) =>
    featureEnabled(config, e.studio),
  );
  const video = featureEnabled(config, "video");
  if (!shown.length && !video) return null;
  return (
    <div className="v1-media">
      <h2>Images, voice and video.</h2>
      <p>
        The same key, allowance, spending cap and signed receipts as chat
        completions, extended to image generation, text-to-speech,
        transcription and video.
      </p>
      <div className="v1-media-examples">
        {shown.map((e) => (
          <div className="code-example" key={e.label}>
            <div>
              <span>{e.label}</span>
              <CopyButton text={e.text} />
            </div>
            <pre>
              <code>{e.text}</code>
            </pre>
          </div>
        ))}
      </div>
      {video && (
        <small>
          Video generation is submitted with POST /v1/videos and polled with
          GET /v1/videos/&#123;id&#125;. See the API docs for the full
          reference.
        </small>
      )}
    </div>
  );
}
