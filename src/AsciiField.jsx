import React, { useEffect, useRef } from "react";
import { attachAsciiField } from "./ascii-field.js";
export default function AsciiField({ sectionRef }) {
  const ref = useRef();
  useEffect(
    () => attachAsciiField(ref.current, sectionRef.current),
    [sectionRef],
  );
  return (
    <div className="ascii-field" aria-hidden="true">
      <img src="/media/ascii/poster.webp" alt="" />
      <canvas ref={ref} width="854" height="480" />
    </div>
  );
}
