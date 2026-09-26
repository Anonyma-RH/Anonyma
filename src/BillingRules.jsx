import React from "react";
import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { featureEnabled } from "./release-copy.js";
import { Notice } from "./ui.jsx";

// Operational rules describe the implemented accounting. The owner approved
// individual refund review, with no automatic refunds.
export default function BillingRules() {
  const { config } = useApp();
  const billing = config?.billing;
  const wallet = config?.walletPayments;
  // Pay with NYMA, once it's released (server/routes/nyma.js).
  const nyma = wallet && config?.nymaPayments;
  return (
    <div className="billing-rules">
      <section>
        <h3>Rates and credit conversion</h3>
        <p>
          1 USD equals 1,000 credits. Credits pay for usage; there is no
          automatic subscription. Choose a model in the{" "}
          <Link to="/models">catalog</Link> and review the estimate before
          submitting. Input and output rates differ by model; options and
          enabled tools can change the cost.
        </p>
        <p>
          The estimate is not a fixed price. Final billing uses the provider
          cost when available, otherwise the model rate and reported or
          estimated token usage. Provider routing can make the final cost differ
          from the catalog estimate. Charges are recorded to four decimal places
          in credits, with fractional accounting units rounded up.
        </p>
      </section>
      <section>
        <h3>Fees</h3>
        {billing ? (
          <ul>
            <li>
              Platform markup: {billing.platformMarkupPercent}%.
            </li>
            <li>
              Primary gateway fee: {billing.gatewayFeePercent}% when the
              provider reports a cost that requires that fee to be added. A
              provider total that already includes fees is used as supplied.
            </li>
            {billing.backupGatewayFeePercent != null && (
              <li>
                Backup gateway fee: {billing.backupGatewayFeePercent}% when that
                gateway is used.
              </li>
            )}
            {featureEnabled(config, "search") && (
              <li>
                Web search: ${billing.webSearchUsd} (
                {Number((billing.webSearchUsd * 1000).toFixed(4))} credits) per
                searched request before platform markup. A searched request
                costs at least its token cost plus this fee.
              </li>
            )}
          </ul>
        ) : (
          <Notice>
            Current fee settings could not be loaded. This page does not assume
            that fees are zero. Recheck the service before making a paid
            request.
          </Notice>
        )}
        <p>
          For wallet deposits, network gas is separate from your ANONYMA credits
          and is shown by your wallet before confirmation. The credited amount
          is based on the supported token actually received; gas does not buy
          credits. The calculator is not a tax invoice or a guarantee of an
          all-inclusive price.
        </p>
      </section>
      <section>
        <h3>Temporary holds and final charges</h3>
        <p>
          Submitting a request temporarily reserves credits, reducing your
          available balance.{" "}
          {billing
            ? `For chat, the service may reserve up to ${billing.reservationMultiplier} times the base estimate for provider cost changes, falling back to the base estimate if your balance or key cap cannot cover that buffer.`
            : "A chat reservation may include a buffer above the base estimate for provider cost changes."}{" "}
          A hold is not a completed charge.
        </p>
        <p>
          When the request settles, its charge is deducted and the unused hold
          is released. The charge cannot exceed that request’s reservation. If a
          request is refused before processing and no failure-billing rule
          applies, its hold is released.
        </p>
      </section>
      <section>
        <h3>Stopped, interrupted and failed requests</h3>
        <ul>
          <li>
            Invalid requests or a provider refusal before processing: no usage
            charge; any hold is released.
          </li>
          <li>
            Stop or disconnect after provider acceptance: input processing can
            be charged even if no answer appeared, plus an enabled search fee
            when applicable.
          </li>
          <li>
            Partial output or an interrupted response: completed work can be
            charged using reported cost or estimated usage. Closing the page
            does not guarantee that provider work stops immediately.
          </li>
          <li>
            <strong>
              Provider timeout or unreadable response: the base estimated cost
              is charged, even if no usable answer arrives.
            </strong>{" "}
            The extra reservation buffer is not charged under this rule.
          </li>
        </ul>
        <p>
          Check <Link to="/account">account activity</Link> and the receipt
          before retrying. A new request can incur a new charge. If a balance or
          charge looks wrong, keep the request reference and contact{" "}
          <Link to="/support">support</Link>.
        </p>
      </section>
      <section>
        <h3>Deposits and failed payments</h3>
        {wallet ? (
          <p>
            Automatic wallet crediting accepts {wallet.symbol} on{" "}
            {wallet.chainName}, sent from the wallet linked to your account to
            the payment address shown on{" "}
            <Link to="/account/credits">Credits &amp; funding</Link>. 1{" "}
            {wallet.symbol} adds 1,000 credits after {wallet.confirmations}{" "}
            confirmations and transfer verification.
          </p>
        ) : (
          <p>
            Use only a payment method currently shown on{" "}
            <Link to="/account/credits">Credits &amp; funding</Link>. Do not
            send funds using an address from an old page, message or unsupported
            network.
          </p>
        )}
        {nyma && (
          <p>
            <span>
              {`Pay with NYMA: ask for a quote on Credits & funding, then send the quoted NYMA on Robinhood Chain from your linked wallet to the same payment address within ${nyma.quoteMinutes} minutes. The quote's rate is the lower of the current rate and its ${nyma.averageMinutes}-minute average on Robinhood Chain, plus a ${Math.round(nyma.bonus * 1000) / 10}% bonus in credits, recorded as a separate NYMA top-up bonus.`}
            </span>{" "}
            <span>
              {`Less NYMA is credited proportionally and more in full; a transfer after the quote ends gets the lower of the quoted and current rates. Up to $${nyma.maxUsd.toLocaleString("en-US")} per payment and $${nyma.dailyMaxUsd.toLocaleString("en-US")} in 24 hours; anything above that is reviewed by support. If there's no reliable rate, NYMA top-ups pause.`}
            </span>
          </p>
        )}
        <ul>
          <li>
            Pending or unconfirmed transfers are not yet spendable. If the
            payment check is unavailable, recheck the same transaction hash
            rather than sending again.
          </li>
          <li>
            A reverted transfer adds no credits. A different token, network,
            sender or recipient does not qualify for automatic crediting.
          </li>
          <li>
            Checking an already credited transaction again does not add credits
            twice. Another account cannot claim it.
          </li>
          <li>
            Transfers more than seven days old require operator review.
            Wrong-network or wrong-address transfers have no guaranteed
            recovery; share the transaction hash with support, never a private
            key or recovery phrase.
          </li>
        </ul>
      </section>
      <section>
        <h3>Refunds and unused credits</h3>
        <Notice>
          Refund requests are reviewed individually. There are no automatic
          refunds. Approval and any refund amount depend on that review;
          submitting a request does not guarantee a refund.
        </Notice>
        <p>
          The app has no self-service cash withdrawal or automatic refund flow.
          Releasing an unused request hold restores available credits; it does
          not return money to a wallet. Closing your account forfeits its
          remaining credit balance under the current account-closure flow.
        </p>
        <p>
          For a disputed charge or payment, use the contact method shown on{" "}
          <Link to="/support">support</Link> and include the request reference
          or transaction hash. Keep those details if the support channel is
          unavailable. A request for review does not itself trigger a refund.
        </p>
      </section>
      <section>
        <h3>Receipts and records</h3>
        <p>
          The generation receipt shows the credits charged. Account activity
          records deposits and usage; the account export includes your ledger.
          Keep these records when reporting a discrepancy. The USD calculator
          illustrates the credit conversion; it is not a payment confirmation.
        </p>
        <p>
          These rules describe the implemented service. Final operator details
          and any applicable tax or invoicing policy remain separate
          commercial-policy requirements.
        </p>
      </section>
    </div>
  );
}
