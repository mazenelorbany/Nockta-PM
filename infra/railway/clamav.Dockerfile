# ClamAV for Railway. The image self-updates its signature database; first boot
# takes 2-3 minutes to warm up. Health probes should allow for this.
FROM clamav/clamav:latest
EXPOSE 3310
