import React, { useEffect, useState } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  Link,
} from "react-router-dom";
import { Context, api, Header, ErrorBox } from "./lib";
import {
  Home,
  Models,
  Calculator,
  Compare,
  Learn,
  Roadmap,
  Token,
  Docs,
  Legal,
} from "./Marketing";
import { SignIn, Account, Support } from "./Account";
import { Workspace } from "./Workspace";
import {
  HowItWorks,
  Developers,
  Methodology,
  About,
  Alternatives,
} from "./Info";
function RouterApp() {
  const [user, setUser] = useState(null),
    [config, setConfig] = useState(null),
    [models, setModels] = useState([]),
    [modelInfo, setModelInfo] = useState(null),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    loc = useLocation();
  async function refresh() {
    const j = await api("/api/me");
    setUser(j.user);
    return j.user;
  }
  useEffect(() => {
    let active = true;
    Promise.allSettled([
      api("/api/config").then((c) => {
        if (active) setConfig(c);
      }),
      api("/api/models").then((m) => {
        if (active) {
          setModels(m.data);
          setModelInfo(m);
        }
      }),
      api("/api/me").then((j) => {
        if (active) setUser(j.user);
      }),
    ])
      .then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (active && failure) setError(failure.reason.message);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title =
      loc.pathname === "/"
        ? "Anonyma — All the models. None of the subscriptions."
        : loc.pathname.split("/")[1].replace(/^./, (s) => s.toUpperCase()) +
          " · Anonyma";
  }, [loc.pathname]);
  return (
    <Context.Provider
      value={{ user, config, models, modelInfo, refresh, ready }}
    >
      <Header />
      {error && (
        <div className="global-error">
          <ErrorBox
            error={"Cannot connect to the application service: " + error}
          />
          <button onClick={() => location.reload()}>Retry connection</button>
        </div>
      )}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/ask" element={<Workspace />} />
        <Route path="/chat" element={<Workspace />} />
        <Route path="/models" element={<Models />} />
        <Route path="/pricing" element={<Models pricing />} />
        <Route path="/calculator" element={<Calculator />} />
        <Route path="/compare" element={<Compare />} />
        <Route path="/compare/:slug" element={<Compare />} />
        <Route path="/learn" element={<Learn />} />
        <Route path="/learn/:slug" element={<Learn />} />
        <Route path="/alternatives" element={<Alternatives />} />
        <Route path="/alternatives/:slug" element={<Alternatives />} />
        <Route path="/how-it-works" element={<HowItWorks />} />
        <Route path="/developers" element={<Developers />} />
        <Route path="/methodology" element={<Methodology />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Support />} />
        <Route path="/roadmap" element={<Roadmap />} />
        <Route path="/token" element={<Token />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:slug" element={<Docs />} />
        <Route path="/docs/community/roadmap" element={<Roadmap />} />
        <Route
          path="/docs/community/changelog"
          element={<Legal type="changelog" />}
        />
        <Route path="/signin" element={<SignIn />} />
        <Route path="/signup" element={<SignIn />} />
        <Route path="/account/*" element={<Account />} />
        <Route path="/support" element={<Support />} />
        {["privacy", "terms", "cookies", "changelog"].map((type) => (
          <Route key={type} path={"/" + type} element={<Legal type={type} />} />
        ))}
        <Route
          path="*"
          element={
            <main className="signed-out">
              <h1>Page not found.</h1>
              <p>That route doesn't exist.</p>
              <Link className="button" to="/">
                Back to home
              </Link>
            </main>
          }
        />
      </Routes>
    </Context.Provider>
  );
}
export function App() {
  return (
    <BrowserRouter>
      <RouterApp />
    </BrowserRouter>
  );
}
