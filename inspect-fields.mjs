name: Inspect Custom Fields diagnostic

on:
  workflow_dispatch:
    inputs:
      batch_name:
        description: "Batch name to inspect, for example Pliny the Elder"
        required: true
        default: "Pliny the Elder"

jobs:
  inspect:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repo
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Run inspect-fields.mjs
        env:
          BF_USER_ID: ${{ secrets.BF_USER_ID }}
          BF_API_KEY: ${{ secrets.BF_API_KEY }}
        run: node scripts/inspect-fields.mjs "${{ github.event.inputs.batch_name }}"
