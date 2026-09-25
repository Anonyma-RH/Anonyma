import React from "react";
import { CopyButton } from "./ui.jsx";

// Copyable curl examples for the /v1 media endpoints, shown on the
// Developers page once the v1media update is released. Placeholder model
// ids match the style of the existing chat-completions example.
const examples = [
  {
    label: "IMAGES",
    text: `curl https://YOUR_ANONYMA_DOMAIN/v1/images/generations \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"YOUR_IMAGE_MODEL_ID","prompt":"A cobalt blue paper airplane","n":1}'`,
  },
  {
    label: "TEXT TO SPEECH",
    text: `curl https://YOUR_ANONYMA_DOMAIN/v1/audio/speech \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"YOUR_VOICE_MODEL_ID","input":"Hello from Anonyma."}' \\\n  --output speech.mp3`,
  },
  {
    label: "TRANSCRIPTION",
    text: `curl https://YOUR_ANONYMA_DOMAIN/v1/audio/transcriptions \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -F "file=@speech.mp3;type=audio/mpeg" \\\n  -F "model=YOUR_TRANSCRIPTION_MODEL_ID"`,
  },
];
export default function V1Media() {
  return (
    <div className="v1-media">
      <h2>Images, voice and video.</h2>
      <p>
        The same key, pricing and holds as chat completions, extended to
        image generation, text-to-speech, transcription and video.
      </p>
      <div className="v1-media-examples">
        {examples.map((e) => (
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
      <small>
        Video generation is submitted with POST /v1/videos and polled with
        GET /v1/videos/&#123;id&#125;. See the API docs for the full
        reference.
      </small>
    </div>
  );
}
