import React from "react";
import { useApp } from "./context.jsx";
import { PageIntro, NotFound } from "./Pages.jsx";
import {
  STATUS_LABEL,
  familyCounts,
  seconds,
  statusReleased,
  useModelStatus,
} from "./model-status.js";
import "./model-status.css";

// Model Status (update "status"): the public /status page. Every number comes
// from GET /api/status: aggregated, from ANONYMA's own traffic, never who.
// The picker's dot and the workspace notice are in StatusDot.jsx.

function Metric({ label, value }) {
  return (
    <span className="ms-metric">
      <small>{label}</small>
      {value}
    </span>
  );
}

function Row({ item, family = false }) {
  return (
    <div className={"ms-row" + (family ? " ms-family" : " ms-model")}>
      <span className="ms-name">
        <span className={"ms-dot " + item.status} aria-hidden="true" />
        <span data-i18n="off">{item.name}</span>
      </span>
      <span className="ms-state">
        <span className={"ms-tag " + item.status}>{STATUS_LABEL[item.status]}</span>
      </span>
      <Metric label="First token, median" value={seconds(item.ttft?.median)} />
      <Metric label="First token, p90" value={seconds(item.ttft?.p90)} />
      <Metric label="Full response, median" value={seconds(item.total?.median)} />
    </div>
  );
}

const time = (t) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// The page's body for one report (GET /api/status): the summary line, the
// families with numbers (and their models), the quiet families, and how it's
// measured. `failed` says the last load didn't answer.
export function StatusBoard({ report, failed = false, testMode = false }) {
  const families = report?.families || [];
  const measured = families.filter((f) => f.status !== "unknown" || f.ttft || f.total);
  const quiet = families.filter((f) => !measured.includes(f));
  const counts = familyCounts(report);
  const min = report?.minSamples ?? 5;
  return (
    <div className="ms-body">
      {testMode && (
        <p className="ms-test">
          Local test installation: these numbers come from its test traffic, not from live models.
        </p>
      )}
      <div className="ms-summary" aria-live="polite">
        {report ? (
          <>
            <span className="ms-count">
              <span className="ms-dot up" aria-hidden="true" />
              {counts.up === 1 ? "1 family up" : `${counts.up} families up`}
            </span>
            <span className="ms-count">
              <span className="ms-dot degraded" aria-hidden="true" />
              {counts.degraded === 1 ? "1 family degraded" : `${counts.degraded} families degraded`}
            </span>
            <span className="ms-count">
              <span className="ms-dot down" aria-hidden="true" />
              {counts.down === 1 ? "1 family down" : `${counts.down} families down`}
            </span>
            <span className="ms-checked">
              {`Checked at ${time(report.checkedAt)} · refreshes every 30 seconds`}
            </span>
          </>
        ) : failed ? (
          <span className="ms-checked">Status couldn't be loaded. It will try again in 30 seconds.</span>
        ) : (
          <span className="ms-checked">Loading status…</span>
        )}
      </div>
      {report && (
        <section className="ms-board" aria-label="Model families">
          <div className="ms-row ms-head" aria-hidden="true">
            <span>Model family</span>
            <span>Status, last 15 minutes</span>
            <span>First token, median</span>
            <span>First token, p90</span>
            <span>Full response, median</span>
          </div>
          {measured.map((f) => (
            <div className="ms-group" key={f.name}>
              <Row item={f} family />
              {f.models.map((m) => (
                <Row item={m} key={m.id} />
              ))}
            </div>
          ))}
          {!measured.length && (
            <p className="ms-empty">
              {`No model has had enough requests in the last hour to show yet. Numbers appear once a model has at least ${min} requests.`}
            </p>
          )}
        </section>
      )}
      {quiet.length > 0 && (
        <section className="ms-quiet" aria-labelledby="ms-quiet-title">
          <h2 id="ms-quiet-title">Not enough data yet</h2>
          <p>
            {`Fewer than ${min} requests in the window. We don't send test requests to fill the gaps, so a quiet model stays here until people use it.`}
          </p>
          <ul>
            {quiet.map((f) => (
              <li key={f.name} data-i18n="off">
                {f.name}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="ms-method" aria-labelledby="ms-method-title">
        <h2 id="ms-method-title">How it's measured</h2>
        <ul>
          <li>
            <b>Real traffic only.</b> Every chat, image and video request through ANONYMA counts once it's sent to
            the provider. Off-the-record and Private requests count the same way. Sealed Mode requests aren't
            measured.
          </li>
          <li>
            <b>Status</b> is the share of requests that failed or timed out in the last 15 minutes: Degraded from
            20%, Down from 50%. Requests we refused before sending, requests you stopped, and requests the provider
            turned down as invalid don't count.
          </li>
          <li>
            <b>Speed</b> is the time from sending a request to its first token, over the last hour: the median, and
            p90 (9 in 10 started faster). Full response is the median time until the reply or image is complete.
          </li>
          <li>
            <b>Never who.</b>{" "}
            {`Only the model, the outcome and the timings are kept, in memory for an hour. No account, prompt or reply, and a restart clears it. Numbers appear only once there are at least ${min} requests, so no one person's use can be picked out.`}
          </li>
        </ul>
      </section>
    </div>
  );
}

export default function ModelStatusPage() {
  const { config, loading } = useApp();
  const live = statusReleased(config);
  const { report, failed } = useModelStatus(live, { every: 30000 });
  if (!config && loading) return <main id="main" className="loading-page" />;
  if (!live) return <NotFound />;
  return (
    <main id="main" className="status-page">
      <PageIntro
        eyebrow="MODEL STATUS"
        title={
          <>
            Which models are up,
            <br />
            right now.
          </>
        }
      >
        Measured from ANONYMA's own traffic in the last hour. It isn't a promise from the provider.
      </PageIntro>
      <StatusBoard report={report} failed={failed} testMode={config?.testMode === true} />
    </main>
  );
}
