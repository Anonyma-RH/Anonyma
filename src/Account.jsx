import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowRight,
  Wallet,
  Mail,
  User,
  KeyRound,
  Plus,
  Trash2,
  Download,
  Copy,
  LogOut,
  RefreshCw,
  Check,
  ShieldCheck,
  Coins,
  Clock,
  ExternalLink,
} from "lucide-react";
import {
  api,
  useApp,
  Button,
  ErrorBox,
  CopyButton,
  Modal,
  fmt,
  date,
  walletSign,
  PageTitle,
  Footer,
  Empty,
} from "./lib";
export function SignIn() {
  const { user, refresh, config } = useApp(),
    navigate = useNavigate(),
    [mode, setMode] = useState("username"),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [challenge, setChallenge] = useState(null),
    [recover, setRecover] = useState(false);
  const next = new URLSearchParams(location.search).get("next");
  const destination =
    next?.startsWith("/") && !next.startsWith("//") ? next : "/ask";
  useEffect(() => {
    if (user) navigate(destination, { replace: true });
  }, [user]);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "wallet") {
        await walletSign(config);
      } else if (mode === "username") {
        await api(register ? "/api/auth/register" : "/api/auth/password", {
          method: "POST",
          body: { username, password },
        });
      } else if (!challenge) {
        setChallenge(
          await api("/api/auth/email/send", {
            method: "POST",
            body: { email, purpose: recover ? "recover" : "login" },
          }),
        );
        return;
      } else
        await api("/api/auth/email/verify", {
          method: "POST",
          body: { id: challenge.id, code, ...(recover ? { password } : {}) },
        });
      await refresh();
      navigate(destination);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="eyebrow">YOUR MODELS. YOUR BALANCE.</div>
        <h1>
          {recover
            ? "Recover account"
            : register
              ? "Create account"
              : "Welcome back."}
        </h1>
        <p>
          {register
            ? "Start with a username. Email is optional."
            : "One account for everything you want to make."}
        </p>
        <div className="segments auth-tabs">
          {[
            ["username", User, "Username"],
            ["wallet", Wallet, "Wallet"],
            ["email", Mail, "Email"],
          ].map(([id, Icon, label]) => (
            <button
              type="button"
              key={id}
              className={mode === id ? "active" : ""}
              onClick={() => {
                setMode(id);
                setError("");
                setChallenge(null);
                setRecover(false);
              }}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
        <ErrorBox error={error} />
        {mode === "username" ? (
          <>
            <label>
              Username
              <input
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Your username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                required
                minLength={register ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  register ? "At least 10 characters" : "Your password"
                }
              />
            </label>
            {!register && (
              <button
                className="text-link forgot"
                type="button"
                onClick={() => {
                  setMode("email");
                  setRecover(true);
                }}
              >
                Forgot password?
              </button>
            )}
            <Button className="full" busy={busy}>
              {register ? "Create account" : "Sign in"} <ArrowRight size={16} />
            </Button>
            <div className="auth-switch">
              {register ? "Already have an account?" : "New here?"}{" "}
              <button
                type="button"
                className="text-link"
                onClick={() => setRegister(!register)}
              >
                {register ? "Sign in" : "Create an account"}
              </button>
            </div>
          </>
        ) : mode === "email" ? (
          <>
            <label>
              Email address
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={!!challenge}
              />
            </label>
            {challenge && (
              <>
                <p className="notice">{challenge.message}</p>
                {challenge.testCode && (
                  <p className="test-note">
                    Local test code: <b>{challenge.testCode}</b>
                  </p>
                )}
                <label>
                  Verification code
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="000000"
                  />
                </label>
                {recover && (
                  <label>
                    New password
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={10}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
            <Button className="full" busy={busy}>
              {challenge ? "Verify & continue" : "Send verification code"}
              <ArrowRight size={16} />
            </Button>
            {challenge && (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setChallenge(null);
                  setCode("");
                }}
              >
                Use a different email / resend
              </button>
            )}
          </>
        ) : (
          <>
            <div className="wallet-intro">
              <Wallet size={38} />
              <h3>Your wallet is your account.</h3>
              <p>
                Sign a message to prove ownership. No transaction or gas fee
                required.
              </p>
            </div>
            <Button className="full" busy={busy}>
              Connect wallet <ArrowUpRight size={16} />
            </Button>
          </>
        )}
        <p className="auth-terms">
          By continuing, you agree to the <Link to="/terms">Terms</Link> and{" "}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </form>
      <Link to="/" className="back-home">
        ← Back to home
      </Link>
    </main>
  );
}