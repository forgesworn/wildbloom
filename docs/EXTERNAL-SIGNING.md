# External signing handoff

External mode supports publication without installing a signer extension in
the Wildbloom browser. It is a manual custody boundary, not a remote-signer
protocol and not an anonymity guarantee.

## What the signer must do

The separate signer must accept a Nostr unsigned-event object containing only
`kind`, `created_at`, `tags` and `content`, show those fields for review, and
return the complete canonical signed event containing only `id`, `pubkey`,
`sig` and those four unchanged fields. The public key entered in Wildbloom must
match the returned event.

Never enter an `nsec`, hexadecimal private key or recovery key into Wildbloom.
Do not use a signing tool that silently rewrites timestamps, tags, content or
event kinds. Wildbloom rejects those changes even when their signature is
cryptographically valid.

## Ceremony

1. Choose **External signer handoff**, enter only the signer's 64-character
   hexadecimal public key, and confirm it.
2. Prepare the file and acknowledge its recovery key and upload disclosure.
3. Choose **Upload prepared payload**. Wildbloom displays a kind `24242`
   unsigned upload authorisation. No upload has begun.
4. Move that unsigned JSON to the signer using a transfer method appropriate
   to the threat model. Review the exact hash, onion or clearnet server and
   five-minute expiry on both sides.
5. Return only the complete signed-event JSON. **Accept signature and continue
   upload** verifies the exact template, author and signature before the first
   upload request.
6. After Blossom accepts the bytes, choose **Review and sign events**. Repeat
   the handoff for the kind `1063` event and, in direct mode, kind `2003` event.
7. Relay publication remains a separate consent and action after every exact
   signature has been accepted.

Changing the file, endpoint, network profile, public key or signing method
cancels a pending handoff and clears downstream authority. An invalid response
leaves the template available for a safe retry. Cancelling the handoff sends
nothing.

## Privacy boundary

The unsigned templates contain intended public metadata: blob hash, server,
timestamps, event content and, in direct mode, tracker and torrent facts. The
returned signed event also contains the public signing identity. The transfer
medium and signer can observe or retain them. A networked signer can make its
own requests, and a reused Nostr identity remains linkable regardless of Tor.

An operating-system clipboard may synchronise to other devices. A downloaded
template remains on disk. Choose the handoff medium deliberately, delete local
copies where that has useful meaning, and keep the recovery key on a separate
channel from the event ID.

Wildbloom's automated Tor gate proves that signed Tor Project Firefox can
publish through disposable v3 onions with this handoff and no signer add-on,
then recover through a fresh profile after `NEWNYM`. It does not prove the
human signer's UI, the transfer medium, anonymity or resistance to traffic
analysis.
