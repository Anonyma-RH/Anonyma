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