# Zeus and Thetis TCI test

In a standard POTACAT launch, select **Radios running Thetis or Zeus (TCI server)** in the welcome wizard or in **Settings → Radio → Add Rig**. Create a rig for each TCI server you want to use. Choose the server application, enter its host and port, and select **Test connection**. The standard rig supports tuning and JTCAT receive and transmit audio for FT8, FT4, FT2, JS8, JTTY, and PSK31. Transmit requires split off, matching receive and transmit dials, USB or DIGU, and Fake It off. WSPR beacon transmit is unavailable until TCI power-cap control is implemented.

## Isolated development profile

The test uses an isolated Electron profile. Start Zeus or Thetis, enable its TCI server, then launch POTACAT from source with a dedicated profile:

```sh
POTACAT_TCI_TEST_DATA="$(mktemp -d)" npm start
```

Use the same dedicated path on later launches to keep the test settings and logbook. Choose **Set up TCI radio** in the welcome wizard or open the TCI editor under **Settings → Radio**. Select Zeus or Thetis and enter its host and port. Each server keeps its own address. The initial port is 40001 for Zeus (or the value of `POTACAT_TCI_TEST_PORT`) and 50001 for Thetis. **Test connection** waits for the server handshake without issuing commands. The test instance follows the current radio dial at startup.

The test defaults to receive. Launch with `POTACAT_TCI_TEST_TX=qso` to use JTCAT's transmit controls for FT8, FT4, FT2, JS8, JTTY, and PSK31. JTCAT's usual transmit watchdog applies to the slotted FT modes. Use `POTACAT_TCI_TEST_TX=1` for an isolated test of one FT8 slot. WSPR transmit needs control of the beacon's RF power cap. Voice and CW use separate transmit paths.

Keep other radio clients disarmed. The transmitter requires matching RX and TX dials in USB or DIGU and releases PTT on completion, Halt, an audio stall, or the waveform deadline. In `qso` mode, the operator can start transmitting again after a halt once the radio is ready. If Zeus cannot be reached after a transport failure, the station's own TX timeout is the backstop. The test ADIF records Zeus's peak forward watts from completed bursts for that QSO.

Set `POTACAT_ZEUS_ENGINE_PORT` to the local Zeus engine HTTP port to enable FT8 RX DSP recall. When changing modes from POTACAT, FT8 saves the original settings and temporarily uses fixed gain with receive noise processing disabled. The next non-FT8 mode selection restores the saved settings. This recall uses Zeus-specific state and receive endpoints, separate from TCI.

### EchoCAT voice on the local network

Launch the isolated profile with `POTACAT_TCI_TEST_ECHOCAT=1`. In **Settings → Network → ECHOCAT**, select **Local network and Cloud**, enable the access password, and use a separate listener port such as 17300. The test build leaves Cloud Tunnel off. Pair your phone with the test instance's own EchoCAT QR code, connect audio, and select USB or LSB. The EchoCAT flag enables voice independently of the digital transmit flag.

EchoCAT sends Zeus receive audio to the phone and feeds the phone microphone back to Zeus while PTT is held. It releases PTT on release, loss of the phone or audio connection, missing mic audio, TCI stream stalls, or the PTT timeout. Voice requires matching receive and transmit dials. Use a dummy load for the first phone test and confirm both modulation and return to receive.
