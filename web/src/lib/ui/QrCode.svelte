<script lang="ts">
  import QRCode from 'qrcode';

  let { value }: { value: string } = $props();
  let svg = $state('');

  $effect(() => {
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then((s) => (svg = s));
  });
</script>

<div class="qr" aria-label="QR code for the room link">
  <!-- Generated locally from our own link; no user HTML involved. -->
  {@html svg}
</div>

<style>
  .qr {
    width: 220px;
    max-width: 100%;
    aspect-ratio: 1;
    background: #fff;
    border-radius: var(--radius-sm);
    padding: 10px;
  }

  .qr :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
