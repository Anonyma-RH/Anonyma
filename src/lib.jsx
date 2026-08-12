import React, { useEffect, useState, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Menu,
  X,
  ChevronDown,
  Copy,
  Check,
  LoaderCircle,
  AlertCircle,
  Plus,
  Wallet,
  LogOut,
  Coins,
} from "lucide-react";
import { useApp } from "./context";
export { Context, useApp } from "./context";
export async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  let j;
  try {
    j = await r.json();
  } catch {
    throw Error("The service returned an unreadable response.");
  }
  if (!r.ok) {
    const error = new Error(j.error?.message || "Request failed.");
    error.status = r.status;
    error.code = j.error?.code;
    error.receipt = j.anonyma;
    error.retryAfter = r.headers.get("Retry-After");
    throw error;
  }
  return j;
}
export const fmt = (n, d = 2) =>
  Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });
export const dollars = (n) =>
  "$" +
  Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });