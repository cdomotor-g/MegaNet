# Sending field photos to Flood-Net — example clients

Two small senders for Flood-Net's photo upload API, one for Node and one for
Python, with nothing to install. Each sends every JPEG, PNG, WebP and HEIC in
a folder, remembers what it sent in `<folder>/.floodnet-sent.json` (so the next
run sends only new photos), waits and retries when asked to, and prints each
photo's receipt.

```sh
export FLOODNET_UPLOAD_KEY=fnp_…        # from a Flood-Net administrator; keep it secret

node send.mjs ./photos --station abergowrie_br_al
python3 send.py ./photos --caption "Site visit 27 Nov"

node send.mjs ./photos --status         # what became of each photo
```

Photos are filed in Flood-Net within about fifteen minutes of being sent.
Everything about the API — every header, parameter and answer — is in
[`docs/agent-api.md`, "Sending field photos"](../../docs/agent-api.md#sending-field-photos).

Copy either file into your own app and change it as you like: the API is
three requests (`PUT /photos`, `GET /photos/{receipt}`, `GET /whoami`), and
these are only one way to make them.
