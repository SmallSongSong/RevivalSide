package dev.revivalside.capture.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.VpnService
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import java.net.InetSocketAddress
import java.net.Socket
import org.json.JSONObject
import java.time.LocalTime
import java.time.format.DateTimeFormatter

class MainActivity : Activity() {
    private lateinit var packageInput: EditText
    private lateinit var gamePortInput: EditText
    private lateinit var httpPortInput: EditText
    private lateinit var assetCdnInput: EditText
    private lateinit var redirectPortsInput: EditText
    private lateinit var eventDateInput: EditText
    private lateinit var loginBackgroundInput: EditText
    private lateinit var joinLobbyAckInput: EditText
    private lateinit var nodePathInput: EditText
    private lateinit var dotnetPathInput: EditText
    private lateinit var listenerStatusText: TextView
    private lateinit var vpnStatusText: TextView
    private lateinit var exportText: TextView
    private lateinit var logText: TextView
    private lateinit var startButton: Button
    private lateinit var captureButton: Button
    private lateinit var extractButton: Button
    private lateinit var userManagerOpenButton: Button
    private lateinit var fierceBossButton: Button
    private lateinit var payloadImportButton: Button
    private lateinit var payloadStatusText: TextView
    private lateinit var payloadProgress: ProgressBar
    private val timeFormat = DateTimeFormatter.ofPattern("HH:mm:ss")
    private val handler = Handler(Looper.getMainLooper())
    private var pendingVpnMode = CounterSideVpnService.MODE_CAPTURE
    private var launchAfterStart = false
    private var launchAfterCapture = false
    private var listenerReadyForLaunch = false
    private var vpnReadyForLaunch = false
    private var startFlowToken = 0
    private var listenerProgressAtMs = 0L
    private var listenerToggleStarting = false
    private var listenerStopCooldown = false
    private var listenerReportedRunning: Boolean? = null
    private lateinit var startupOverlay: LinearLayout
    private lateinit var startupStageText: TextView
    private lateinit var startupDetailText: TextView
    private lateinit var startupProgress: ProgressBar
    private lateinit var startupReturnButton: Button

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val message = intent.getStringExtra(CounterSideVpnService.EXTRA_MESSAGE)
                ?: intent.getStringExtra(RevivalSideListenerService.EXTRA_MESSAGE)
                ?: return
            when (intent.action) {
                CounterSideVpnService.ACTION_STATUS -> {
                    vpnStatusText.text = message
                    appendLog("VPN: $message")
                    if (message.startsWith("Redirecting") || message.contains("already", ignoreCase = true)) {
                        vpnReadyForLaunch = true
                        tryLaunchAfterStart()
                    }
                    if (launchAfterCapture && message.startsWith("Recording")) {
                        launchAfterCapture = false
                        setCaptureButtonBusy(false)
                        appendLog("Launching CounterSide for JOIN_LOBBY_ACK capture")
                        launchCounterSide()
                    } else if (launchAfterCapture && message.startsWith("Failed")) {
                        launchAfterCapture = false
                        setCaptureButtonBusy(false)
                    }
                    val exportPath = intent.getStringExtra(CounterSideVpnService.EXTRA_EXPORT_PATH)
                    if (!exportPath.isNullOrBlank()) exportText.text = exportPath
                }
                RevivalSideListenerService.ACTION_STATUS -> {
                    listenerStatusText.text = message
                    appendLog("Listener: $message")
                    if (isListenerStartupProgress(message)) listenerProgressAtMs = SystemClock.elapsedRealtime()
                    // Runtime creation is only the beginning of readiness, not its completion.
                    if (message.startsWith("Listener online") || message.startsWith("Listener runtime started") || message.startsWith("Listener is already running")) listenerReportedRunning = true
                    if (message.startsWith("Listener failed") || message.startsWith("Listener stopped")) listenerReportedRunning = false
                    if (listenerToggleStarting && (message.startsWith("Listener failed") || message.startsWith("Listener stopped"))) {
                        failListenerStartup(message)
                    }
                    syncListenerToggle()
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        window.decorView.isFocusableInTouchMode = true
        window.decorView.requestFocus()
        requestNotificationPermissionIfNeeded()
        registerStatusReceiver()
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) { onBackPressed() }
        }
        appendLog("Ready")
        if (savedInstanceState?.getBoolean("listenerStarting") == true || RevivalSideListenerService.isRunning(this)) {
            beginListenerStartup(saveSettingsFromInputs(), startRuntime = false)
        }
    }

    override fun onResume() {
        super.onResume()
        if (!listenerStopCooldown && !listenerToggleStarting) listenerReportedRunning = RevivalSideListenerService.isRunning(this)
        syncListenerToggle()
    }

    override fun onDestroy() {
        startFlowToken += 1
        handler.removeCallbacksAndMessages(null)
        runCatching { unregisterReceiver(statusReceiver) }
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("listenerStarting", listenerToggleStarting)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("This dependency-free Activity uses the platform back callback.")
    override fun onBackPressed() {
        if (listenerToggleStarting) return
        if (::startupOverlay.isInitialized && startupOverlay.visibility == View.VISIBLE) {
            startupOverlay.visibility = View.GONE
            return
        }
        super.onBackPressed()
    }

    @Deprecated("VPN permission result uses the platform callback for this no-dependency app.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PAYLOAD_ZIP_REQUEST) {
            if (resultCode == RESULT_OK && data?.data != null) {
                val uri = data.data!!
                runCatching {
                    contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                importPayloadZip(uri)
            } else {
                setPayloadImportBusy(false)
                appendLog("Payload ZIP selection cancelled")
            }
        } else if (requestCode == VPN_REQUEST && resultCode == RESULT_OK) {
            startVpnService(pendingVpnMode)
        } else if (requestCode == VPN_REQUEST && launchAfterStart) {
            failStartOperation("VPN permission was not granted")
        } else if (requestCode == VPN_REQUEST && launchAfterCapture) {
            launchAfterCapture = false
            setCaptureButtonBusy(false)
            appendLog("Official server capture needs VPN permission")
        }
    }

    private fun buildUi(): View {
        val settings = RevivalSideSettingsStore.load(this)
        val root = FrameLayout(this).apply {
            background = verticalGradient(0xff101827.toInt(), 0xff322334.toInt())
            isFocusableInTouchMode = true
            descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(22), dp(22), dp(112))
        }

        content.addView(TextView(this).apply {
            text = "RevivalSide"
            textSize = 38f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xffffffff.toInt())
        })
        content.addView(TextView(this).apply {
            text = "Android listener"
            textSize = 16f
            setTextColor(0xffcbd5e1.toInt())
            setPadding(0, dp(1), 0, dp(18))
        })

        val statusPanel = panel().apply {
            addView(eyebrow("Status"))
            listenerStatusText = statusText("Idle")
            addView(listenerStatusText)
            vpnStatusText = statusText("VPN idle")
            addView(vpnStatusText)
            addView(chipRow(
                chip("Target", settings.targetPackage.substringAfterLast('.')),
                chip("Port", settings.gamePort.toString()),
            ))
            fierceBossButton = Button(this@MainActivity).apply {
                text = "激战支援 Boss"
                textSize = 16f
                setTextColor(0xfff8fafc.toInt())
                background = rounded(0xff102033.toInt(), dp(10), 0xfffbbf24.toInt())
                setOnClickListener { openFierceBossSelector() }
            }
            addView(fierceBossButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54)).apply {
                topMargin = dp(12)
            })
            addView(mutedText("切换后重新进入游戏内激战支援即可，无需重启服务。", 12f), fillWrap().apply {
                topMargin = dp(6)
            })
            addView(userManagerButton(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54)).apply {
                topMargin = dp(12)
            })
            payloadStatusText = mutedText(
                if (AndroidPayloadCache.activeRoot(this@MainActivity) != null) "Android payload cache ready" else "Android payload ZIP not imported",
                13f,
            )
            addView(payloadStatusText, fillWrap().apply { topMargin = dp(12) })
            payloadProgress = ProgressBar(
                this@MainActivity,
                null,
                android.R.attr.progressBarStyleHorizontal,
            ).apply {
                max = 1000
                progress = 0
                visibility = View.GONE
            }
            addView(payloadProgress, fillWrap().apply { topMargin = dp(6) })
            addView(createPayloadImportButton(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(54)).apply {
                topMargin = dp(8)
            })
        }
        content.addView(statusPanel, fillWrapWithBottom(dp(14)))

        val configPanel = panel().apply {
            addView(eyebrow("Connection"))
            packageInput = singleLineInput(settings.targetPackage)
            addView(label("CounterSide package"))
            addView(packageInput, fillWrap())

            val portRow = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.START
            }
            gamePortInput = numberInput(settings.gamePort.toString())
            httpPortInput = numberInput(settings.httpPort.toString())
            portRow.addView(fieldColumn("Game", gamePortInput), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            portRow.addView(fieldColumn("HTTP", httpPortInput), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(portRow)

            assetCdnInput = singleLineInput(settings.assetCdnBaseUrl)
            addView(label("Android asset CDN"))
            addView(assetCdnInput, fillWrap())

            redirectPortsInput = singleLineInput(settings.redirectPortsText)
            addView(label("VPN ports"))
            addView(redirectPortsInput, fillWrap())

            eventDateInput = singleLineInput(settings.eventDate)
            addView(label("Event date (YYYY-MM-DD, blank = live clock)"))
            addView(eventDateInput, fillWrap())

            loginBackgroundInput = singleLineInput(settings.loginBackground)
            addView(label("Login background (auto or ID)"))
            addView(loginBackgroundInput, fillWrap())

            joinLobbyAckInput = singleLineInput(settings.joinLobbyAckMode)
            addView(label("JOIN_LOBBY_ACK"))
            addView(joinLobbyAckInput, fillWrap())

            nodePathInput = singleLineInput(settings.nodePath)
            dotnetPathInput = singleLineInput(settings.dotnetPath)
            addView(label("Node path"))
            addView(nodePathInput, fillWrap())
            addView(label("Dotnet path"))
            addView(dotnetPathInput, fillWrap())
        }
        content.addView(configPanel, fillWrapWithBottom(dp(14)))

        val logPanel = panel().apply {
            addView(eyebrow("Activity"))
            logText = TextView(this@MainActivity).apply {
                textSize = 12f
                setTextColor(0xffdbeafe.toInt())
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = rounded(0xaa06090d.toInt(), dp(10), 0x335f7ea0)
                typeface = Typeface.MONOSPACE
            }
            addView(logText, fillWrap())
        }
        content.addView(logPanel, fillWrapWithBottom(dp(14)))

        val exportPanel = panel().apply {
            addView(eyebrow("Latest Export"))
            exportText = mutedText(CaptureRepository.latestExport(this@MainActivity)?.absolutePath ?: "No export yet", 13f)
            addView(exportText)
            addView(Button(this@MainActivity).apply {
                text = "EXPORT SAVE + LOGS"
                setOnClickListener { exportSaveAndLogs() }
            }, fillWrap().apply { topMargin = dp(10) })
        }
        content.addView(exportPanel, fillWrap())

        val scroll = ScrollView(this).apply {
            isFillViewport = false
            addView(content)
        }
        root.addView(scroll, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(bottomBar(), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        startupOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            background = verticalGradient(0xff101827.toInt(), 0xff171e30.toInt())
            isClickable = true
            isFocusable = true
            visibility = View.GONE
            addView(statusText("正在启动 RevivalSide").apply { textSize = 26f }, fillWrap())
            startupStageText = statusText("")
            addView(startupStageText, fillWrapWithBottom(dp(16)))
            startupProgress = ProgressBar(this@MainActivity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 4 }
            addView(startupProgress, fillWrapWithBottom(dp(16)))
            startupDetailText = mutedText("", 15f)
            addView(startupDetailText, fillWrapWithBottom(dp(20)))
            startupReturnButton = Button(this@MainActivity).apply {
                text = "返回"
                visibility = View.GONE
                setOnClickListener { startupOverlay.visibility = View.GONE }
            }
            addView(startupReturnButton, fillWrap())
        }
        root.addView(startupOverlay, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        return root
    }

    private fun bottomBar(): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(14), dp(18), dp(18))
            background = verticalGradient(0xee070b12.toInt(), 0xff0b1020.toInt())
            startButton = Button(this@MainActivity).apply {
                text = "START"
                textSize = 17f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xff06111f.toInt())
                background = rounded(0xfff8fafc.toInt(), dp(10), 0xffffffff.toInt())
                setPadding(dp(10), 0, dp(10), 0)
                minHeight = dp(58)
                setOnClickListener {
                    if (listenerReportedRunning ?: RevivalSideListenerService.isRunning(this@MainActivity)) stopOperation() else startOperation()
                }
            }
            addView(startButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(62)))
        }
    }

    private fun syncListenerToggle() {
        if (!::startButton.isInitialized) return
        startButton.isEnabled = !listenerToggleStarting && !listenerStopCooldown
        startButton.text = when {
            listenerToggleStarting -> "STARTING"
            (listenerReportedRunning ?: RevivalSideListenerService.isRunning(this@MainActivity)) -> "STOP"
            else -> "START"
        }
    }

    private fun startOperation() {
        beginListenerStartup(saveSettingsFromInputs(), startRuntime = true)
    }

    private fun showStartupStage(completedSteps: Int, stage: String) {
        startupOverlay.visibility = View.VISIBLE
        startupProgress.visibility = View.VISIBLE
        startupProgress.progress = completedSteps
        startupStageText.text = stage
        startupDetailText.text = "启动期间请留在此页面，完成后再进入游戏。首次启动可能需要较长时间。"
        startupReturnButton.visibility = View.GONE
        startupOverlay.requestFocus()
    }

    private fun beginListenerStartup(settings: RevivalSideSettings, startRuntime: Boolean) {
        val token = ++startFlowToken
        launchAfterStart = false
        launchAfterCapture = false
        listenerToggleStarting = true
        listenerProgressAtMs = SystemClock.elapsedRealtime()
        showStartupStage(0, "1/4 · 准备服务与资源")
        syncListenerToggle()
        runCatching {
            if (startRuntime) startListener(settings)
            waitForStartupHealth(settings, token)
        }.onFailure { failListenerStartup("启动服务失败：${it.message}") }
    }

    private fun waitForStartupHealth(settings: RevivalSideSettings, token: Int) {
        if (token != startFlowToken || !listenerToggleStarting) return
        Thread {
            val health = readListenerHealth(settings)
            runOnUiThread {
                if (token != startFlowToken || !listenerToggleStarting) return@runOnUiThread
                when {
                    health.ready -> prepareListenerForPlay(settings, token)
                    health.fatalMessage.isNotBlank() -> failListenerStartup(health.fatalMessage)
                    listenerHealthTimedOut() -> failListenerStartup("等待服务就绪超时，请返回后停止服务并重试。")
                    else -> {
                        showStartupStage(1, "2/4 · 等待游戏服务端口")
                        handler.postDelayed({ waitForStartupHealth(settings, token) }, LISTENER_HEALTH_INTERVAL_MS)
                    }
                }
            }
        }.start()
    }

    private fun prepareListenerForPlay(settings: RevivalSideSettings, token: Int) {
        showStartupStage(2, "3/4 · 预热大厅与账号数据")
        Thread {
            val result = runCatching {
                val mode = requestServerInfoMode(settings, SERVER_MODE_REVIVALSIDE)
                check(mode.ok) { "选择本地服务器失败：${mode.summary}" }
                val warmup = requestListenerWarmup(settings)
                check(warmup.ok) { "大厅数据预热失败：${warmup.summary}" }
                runOnUiThread {
                    if (token == startFlowToken && listenerToggleStarting) showStartupStage(3, "4/4 · 验证客户端连接地址")
                }
                verifyGameEndpoints(settings)
            }
            runOnUiThread {
                if (token != startFlowToken || !listenerToggleStarting) return@runOnUiThread
                result.onSuccess {
                    listenerToggleStarting = false
                    listenerReportedRunning = true
                    startupProgress.progress = 4
                    startupOverlay.visibility = View.GONE
                    listenerStatusText.text = "服务已就绪，可以进入游戏"
                    startService(Intent(this, RevivalSideListenerService::class.java).setAction(RevivalSideListenerService.ACTION_READY))
                    appendLog("Listener ready: lobby warmed and ServerInfo/game TCP verified")
                    syncListenerToggle()
                }.onFailure { failListenerStartup(it.message ?: "连接验证失败") }
            }
        }.start()
    }

    private fun verifyGameEndpoints(settings: RevivalSideSettings) {
        val connection = URL("http://127.0.0.1:${settings.httpPort}/revivalsideapk/server_config/live/ServerInfo_V2.json").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 2000
            connection.readTimeout = 5000
            connection.useCaches = false
            check(connection.responseCode == 200) { "客户端服务器地址不可用：HTTP ${connection.responseCode}" }
            val servers = JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getJSONObject("server")
            val gameServer = servers.getJSONObject("Global")
            check(gameServer.getString("ip") in listOf("127.0.0.1", "localhost") && gameServer.getInt("port") == settings.gamePort) {
                "客户端服务器地址未指向本地服务，请检查端口设置。"
            }
        } finally {
            connection.disconnect()
        }
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", settings.gamePort), 2000) }
    }

    private fun failListenerStartup(message: String) {
        startFlowToken += 1
        listenerToggleStarting = false
        listenerReportedRunning = RevivalSideListenerService.isRunning(this)
        startupOverlay.visibility = View.VISIBLE
        startupProgress.visibility = View.GONE
        startupStageText.text = "服务尚未就绪"
        startupDetailText.text = message
        startupReturnButton.visibility = View.VISIBLE
        listenerStatusText.text = message
        appendLog(message)
        syncListenerToggle()
    }

    private fun openPayloadZipPicker() {
        startFlowToken += 1
        launchAfterStart = false
        launchAfterCapture = false
        stopVpnService()
        stopListener()
        setPayloadImportBusy(true)
        appendLog("Select the downloaded RevivalSide Android payload ZIP")
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }
        runCatching { startActivityForResult(intent, PAYLOAD_ZIP_REQUEST) }
            .onFailure {
                setPayloadImportBusy(false)
                appendLog("Could not open the Android file picker: ${it.message}")
            }
    }

    private fun importPayloadZip(uri: Uri) {
        setPayloadImportBusy(true)
        payloadStatusText.text = "Checking payload manifest..."
        payloadProgress.progress = 0
        payloadProgress.visibility = View.VISIBLE
        Thread {
            val result = AndroidPayloadCache.importZip(applicationContext, uri) { current ->
                runOnUiThread {
                    val ratio = if (current.totalBytes > 0L) current.bytes.toDouble() / current.totalBytes else 0.0
                    payloadProgress.progress = (ratio * payloadProgress.max).toInt().coerceIn(0, payloadProgress.max)
                    payloadStatusText.text = "Importing ${current.files}/${current.totalFiles} (${(ratio * 100).toInt()}%) • ${current.currentPath.substringAfterLast('/')}"
                }
            }
            runOnUiThread {
                setPayloadImportBusy(false)
                if (result.ok) {
                    payloadProgress.progress = payloadProgress.max
                    payloadStatusText.text = "Android payload cache ready"
                    assetCdnInput.setText(AndroidPayloadCache.localCdnBaseUrl(RevivalSideSettingsStore.parsePort(httpPortInput.text.toString(), DEFAULT_HTTP_PORT)))
                    saveSettingsFromInputs()
                    appendLog(result.message)
                } else {
                    payloadProgress.visibility = View.GONE
                    payloadStatusText.text = result.message
                    appendLog(result.message)
                }
            }
        }.start()
    }

    private fun startJoinLobbyAckCapture() {
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        launchAfterStart = false
        launchAfterCapture = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        setUserManagerButtonBusy(false)
        setCaptureButtonBusy(true)
        listenerToggleStarting = false
        syncListenerToggle()
        appendLog("Switching to the official server for JOIN_LOBBY_ACK capture")
        stopVpnService()
        startListener(settings)
        waitForOfficialServerBridge(settings, token, attempt = 0)
    }

    private fun extractAndCopyLatestJoinLobbyAck() {
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        launchAfterStart = false
        launchAfterCapture = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        setUserManagerButtonBusy(false)
        setExtractButtonBusy(true)
        appendLog("Extract + copy requested")
        Thread {
            val extracted = runCatching {
                CaptureRepository.extractLatestJoinLobbyAckToCapturedGameFlow(applicationContext)
            }
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                val error = extracted.exceptionOrNull()
                if (error != null) {
                    appendLog("Extract + copy failed: ${error.message}")
                    setExtractButtonBusy(false)
                    return@runOnUiThread
                }
                val result = extracted.getOrThrow()
                exportText.text = result.targetDir.absolutePath
                appendLog("Copied JOIN_LOBBY_ACK bundle files=${result.copiedFiles} bytes=${result.copiedBytes}")
                startListener(settings)
                waitForListenerHealthForImport(settings, token, attempt = 0)
            }
        }.start()
    }

    private fun stopOperation() {
        startFlowToken += 1
        launchAfterStart = false
        launchAfterCapture = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        setUserManagerButtonBusy(false)
        listenerToggleStarting = false
        listenerReportedRunning = false
        listenerStopCooldown = true
        syncListenerToggle()
        setCaptureButtonBusy(false)
        setExtractButtonBusy(false)
        appendLog("Stop requested")
        stopVpnService()
        stopListener()
        syncListenerToggle()
        // The embedded Node process exits after 250 ms; prevent a restart racing that exit.
        handler.postDelayed({ listenerStopCooldown = false; syncListenerToggle() }, 500L)
    }

    private fun setExtractButtonBusy(busy: Boolean) {
        if (!::extractButton.isInitialized) return
        extractButton.isEnabled = !busy
        extractButton.text = if (busy) "COPYING" else "EXTRACT"
    }

    private fun tryLaunchAfterStart() {
        if (!launchAfterStart || !listenerReadyForLaunch || !vpnReadyForLaunch) return
        launchAfterStart = false
        appendLog("Launching CounterSide")
        listenerToggleStarting = false
        syncListenerToggle()
        launchCounterSide()
    }

    private fun failStartOperation(message: String) {
        launchAfterStart = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        appendLog(message)
        listenerToggleStarting = false
        syncListenerToggle()
    }

    private fun waitForListenerHealth(settings: RevivalSideSettings, token: Int, attempt: Int) {
        if (!launchAfterStart || token != startFlowToken) return
        if (attempt == 0) {
            listenerStatusText.text = "Waiting for listener health"
            appendLog("Waiting for listener health on 127.0.0.1:${settings.httpPort}")
        }
        Thread {
            val health = readListenerHealth(settings)
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (health.ready) {
                    listenerStatusText.text = "Listener ready"
                    appendLog("Listener health ready")
                    switchToRevivalSideAndWarmup(settings, token)
                    return@runOnUiThread
                }
                if (health.fatalMessage.isNotBlank()) {
                    failStartOperation(health.fatalMessage)
                    return@runOnUiThread
                }
                if (listenerHealthTimedOut()) {
                    failStartOperation("Listener health timed out")
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) {
                    appendLog("Still waiting for listener health (${attempt}s)")
                }
                handler.postDelayed({
                    waitForListenerHealth(settings, token, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun switchToRevivalSideAndWarmup(settings: RevivalSideSettings, token: Int) {
        if (!launchAfterStart || token != startFlowToken) return
        listenerStatusText.text = "Selecting RevivalSide server"
        Thread {
            val result = requestServerInfoMode(settings, SERVER_MODE_REVIVALSIDE)
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (!result.ok) {
                    failStartOperation("Could not select RevivalSide server${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                    return@runOnUiThread
                }
                appendLog("Server switched to RevivalSide")
                waitForListenerWarmup(settings, token)
            }
        }.start()
    }

    private fun waitForOfficialServerBridge(settings: RevivalSideSettings, token: Int, attempt: Int) {
        if (token != startFlowToken) return
        if (attempt == 0) listenerStatusText.text = "Selecting official server"
        Thread {
            val result = requestServerInfoMode(settings, SERVER_MODE_OFFICIAL)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (result.ok) {
                    listenerStatusText.text = "Official server selected"
                    appendLog("Official server bridge ready; starting ACK capture")
                    launchAfterCapture = true
                    beginVpnFlow(CounterSideVpnService.MODE_CAPTURE)
                    return@runOnUiThread
                }
                if (listenerHealthTimedOut()) {
                    setCaptureButtonBusy(false)
                    appendLog("Official server bridge timed out${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) appendLog("Still waiting for official server bridge (${attempt}s)")
                handler.postDelayed({
                    waitForOfficialServerBridge(settings, token, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun waitForListenerWarmup(settings: RevivalSideSettings, token: Int) {
        if (!launchAfterStart || token != startFlowToken) return
        listenerStatusText.text = "Warming lobby data"
        appendLog("Warming lobby data before launch")
        Thread {
            val result = requestListenerWarmup(settings)
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (result.ok) {
                    listenerReadyForLaunch = true
                    listenerStatusText.text = "Listener ready"
                    appendLog("Lobby warmup ready${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                    tryLaunchAfterStart()
                } else {
                    failStartOperation("Lobby warmup failed${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                }
            }
        }.start()
    }

    private fun waitForListenerHealthForImport(settings: RevivalSideSettings, token: Int, attempt: Int) {
        if (token != startFlowToken) return
        if (attempt == 0) {
            listenerStatusText.text = "Waiting for listener import API"
            appendLog("Waiting for listener import API on 127.0.0.1:${settings.httpPort}")
        }
        Thread {
            val ready = isListenerHealthReady(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (ready) {
                    listenerStatusText.text = "Listener ready"
                    importLatestOfficialProfile(settings, token)
                    return@runOnUiThread
                }
                if (listenerHealthTimedOut()) {
                    appendLog("Listener import API timed out")
                    setExtractButtonBusy(false)
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) {
                    appendLog("Still waiting for listener import API (${attempt}s)")
                }
                handler.postDelayed({
                    waitForListenerHealthForImport(settings, token, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun importLatestOfficialProfile(settings: RevivalSideSettings, token: Int) {
        if (token != startFlowToken) return
        appendLog("Importing copied JOIN_LOBBY_ACK profile")
        Thread {
            val result = requestOfficialProfileImport(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (result.ok) {
                    appendLog("Imported profile${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                } else {
                    appendLog("Official profile import failed${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                }
                setExtractButtonBusy(false)
            }
        }.start()
    }

    private fun isListenerHealthReady(settings: RevivalSideSettings): Boolean {
        return readListenerHealth(settings).ready
    }

    private fun readListenerHealth(settings: RevivalSideSettings): ListenerHealth {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${settings.httpPort}/launcher/api/health").openConnection() as HttpURLConnection).apply {
                connectTimeout = 1000
                readTimeout = 1000
                requestMethod = "GET"
                useCaches = false
            }
            if (connection.responseCode !in 200..299) return ListenerHealth(false)
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val health = JSONObject(body)
            val correctPort = health.optInt("port") == settings.gamePort
            val combatHost = health.optJSONObject("combatHost")
            if (correctPort && health.optBoolean("ok")) {
                ListenerHealth(true)
            } else if (correctPort && combatHost?.optBoolean("enabled") == true && !combatHost.optBoolean("ready")) {
                ListenerHealth(false, combatHost.optString("error").ifBlank { "战斗服务初始化失败，请返回后停止服务并重试。" })
            } else {
                ListenerHealth(false)
            }
        } catch (_: Exception) {
            ListenerHealth(false)
        } finally {
            connection?.disconnect()
        }
    }

    private fun requestListenerWarmup(settings: RevivalSideSettings): WarmupResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${settings.httpPort}/launcher/api/warmup").openConnection() as HttpURLConnection).apply {
                connectTimeout = LISTENER_WARMUP_CONNECT_TIMEOUT_MS
                readTimeout = LISTENER_WARMUP_READ_TIMEOUT_MS
                requestMethod = "POST"
                useCaches = false
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val response = JSONObject(body)
            if (status in 200..299 && response.optBoolean("ok")) {
                WarmupResult(true, extractWarmupSummary(body))
            } else {
                val error = response.optString("error").ifBlank {
                    response.optJSONObject("joinLobbyAck")?.optJSONArray("errors")?.optJSONObject(0)?.optString("error").orEmpty()
                }
                WarmupResult(false, error.ifBlank { "HTTP $status" })
            }
        } catch (error: Exception) {
            WarmupResult(false, error.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun requestServerInfoMode(settings: RevivalSideSettings, mode: String): ServerInfoModeResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${settings.httpPort}/launcher/api/server-info-mode?mode=$mode").openConnection() as HttpURLConnection).apply {
                connectTimeout = 1000
                readTimeout = 2000
                requestMethod = "POST"
                useCaches = false
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val compact = response.filterNot { it.isWhitespace() }
            if (status in 200..299 && compact.contains("\"ok\":true") && compact.contains("\"serverInfoMode\":\"$mode\"")) {
                ServerInfoModeResult(true)
            } else if (status == 404 && mode == SERVER_MODE_REVIVALSIDE) {
                ServerInfoModeResult(true, "PC 0.4.0 default")
            } else {
                ServerInfoModeResult(false, extractJsonString(compact, "error").ifBlank { "HTTP $status" })
            }
        } catch (error: Exception) {
            ServerInfoModeResult(false, error.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun requestOfficialProfileImport(settings: RevivalSideSettings): ImportResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${settings.httpPort}/launcher/api/official-profile/import-latest").openConnection() as HttpURLConnection).apply {
                connectTimeout = LISTENER_WARMUP_CONNECT_TIMEOUT_MS
                readTimeout = LISTENER_WARMUP_READ_TIMEOUT_MS
                requestMethod = "POST"
                doOutput = true
                useCaches = false
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            val body = """{"switchActive":true}""".toByteArray(Charsets.UTF_8)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val compact = response.filterNot { it.isWhitespace() }
            if (status in 200..299 && compact.contains("\"ok\":true")) {
                ImportResult(true, extractImportSummary(compact))
            } else {
                ImportResult(false, extractJsonString(compact, "error").ifBlank { "HTTP $status" })
            }
        } catch (error: Exception) {
            ImportResult(false, error.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun extractWarmupSummary(compactJson: String): String {
        val warmed = Regex("\"warmed\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        val duration = Regex("\"durationMs\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        return listOfNotNull(
            warmed?.let { "$it profile(s)" },
            duration?.let { "${it}ms" },
        ).joinToString(" ")
    }

    private fun extractImportSummary(compactJson: String): String {
        val nickname = extractJsonString(compactJson, "nickname")
        val userUid = extractJsonString(compactJson, "userUid")
        val units = Regex("\"units\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        return listOfNotNull(
            nickname.takeIf { it.isNotBlank() },
            userUid.takeIf { it.isNotBlank() }?.let { "uid=$it" },
            units?.let { "units=$it" },
        ).joinToString(" ")
    }

    private fun extractJsonString(compactJson: String, key: String): String {
        return Regex("\"${Regex.escape(key)}\":\"((?:\\\\.|[^\"])*)\"")
            .find(compactJson)
            ?.groupValues
            ?.getOrNull(1)
            ?.replace("\\\"", "\"")
            ?.replace("\\\\", "\\")
            .orEmpty()
    }

    private fun startListener(settings: RevivalSideSettings = saveSettingsFromInputs()) {
        listenerProgressAtMs = SystemClock.elapsedRealtime()
        val service = Intent(this, RevivalSideListenerService::class.java).apply {
            action = RevivalSideListenerService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        appendLog("Starting listener on 127.0.0.1:${settings.httpPort}")
    }

    private fun listenerHealthTimedOut(): Boolean {
        return SystemClock.elapsedRealtime() - listenerProgressAtMs >= LISTENER_HEALTH_TIMEOUT_MS
    }

    private fun isListenerStartupProgress(message: String): Boolean {
        return message.startsWith("Preparing ") ||
            message.startsWith("Installed ") ||
            message.startsWith("Starting Android listener") ||
            message.startsWith("Bundled combat host") ||
            message.startsWith("Started embedded ") ||
            message.startsWith("Started bundled ")
    }

    private fun stopListener() {
        startService(Intent(this, RevivalSideListenerService::class.java).apply {
            action = RevivalSideListenerService.ACTION_STOP
        })
        appendLog("Stopping listener")
    }

    private fun beginVpnFlow(mode: String) {
        saveSettingsFromInputs()
        pendingVpnMode = mode
        val intent = VpnService.prepare(this)
        if (intent != null) {
            startActivityForResult(intent, VPN_REQUEST)
        } else {
            startVpnService(mode)
        }
    }

    private fun startVpnService(mode: String) {
        val settings = saveSettingsFromInputs()
        val service = Intent(this, CounterSideVpnService::class.java).apply {
            action = CounterSideVpnService.ACTION_START
            putExtra(CounterSideVpnService.EXTRA_TARGET_PACKAGE, settings.targetPackage)
            putExtra(CounterSideVpnService.EXTRA_MODE, mode)
            putExtra(CounterSideVpnService.EXTRA_LISTENER_PORT, settings.gamePort)
            putExtra(CounterSideVpnService.EXTRA_HTTP_PORT, settings.httpPort)
            putExtra(CounterSideVpnService.EXTRA_REDIRECT_PORTS, settings.redirectPortsText)
        }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        appendLog(if (mode == CounterSideVpnService.MODE_LISTENER) "Starting VPN redirect" else "Starting official login capture")
    }

    private fun stopVpnService() {
        startService(Intent(this, CounterSideVpnService::class.java).apply {
            action = CounterSideVpnService.ACTION_STOP
        })
        appendLog("Stopping VPN")
    }

    private fun setCaptureButtonBusy(busy: Boolean) {
        if (!::captureButton.isInitialized) return
        captureButton.isEnabled = !busy
        captureButton.text = if (busy) "SWITCHING" else "OFFICIAL + ACK"
    }

    private fun openUserManager() {
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        val url = userManagerUrl(settings)
        launchAfterStart = false
        launchAfterCapture = false
        setUserManagerButtonBusy(true)
        appendLog("Opening user manager")
        startListener(settings)
        waitForUserManager(settings, token, url, attempt = 0)
    }

    private fun openFierceBossSelector() {
        val settings = saveSettingsFromInputs()
        fierceBossButton.isEnabled = false
        fierceBossButton.text = "正在加载 Boss…"
        Thread {
            val result = runCatching { FierceBossApi.load(settings.httpPort) }
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                fierceBossButton.isEnabled = true
                fierceBossButton.text = "激战支援 Boss"
                result.onSuccess { state -> showFierceBossSelector(state) }
                    .onFailure { error -> showFierceBossError(error) }
            }
        }.start()
    }

    private fun showFierceBossSelector(state: FierceBossState) {
        val choices = listOf(FierceBossOption(0, "自动轮换")) + state.options
        var selected = choices.indexOfFirst { it.seasonId == state.seasonId }.coerceAtLeast(0)
        val dialog = AlertDialog.Builder(this)
            .setTitle("激战支援 Boss · 当前：${state.activeName}")
            .setSingleChoiceItems(choices.map { it.name }.toTypedArray(), selected) { _, index -> selected = index }
            .setNegativeButton("取消", null)
            .setPositiveButton("保存并切换", null)
            .create()
        dialog.setOnShowListener {
            val save = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            save.setOnClickListener {
                val seasonId = choices[selected].seasonId
                save.isEnabled = false
                dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled = false
                dialog.setCancelable(false)
                save.text = "正在切换…"
                Thread {
                    val result = runCatching { FierceBossApi.save(state.port, seasonId) }
                    runOnUiThread {
                        if (isFinishing || isDestroyed) return@runOnUiThread
                        result.onSuccess { updated ->
                            dialog.dismiss()
                            appendLog("激战支援 Boss：${updated.activeName}")
                            AlertDialog.Builder(this)
                                .setTitle("已切换为：${updated.activeName}")
                                .setMessage("返回游戏，退出并重新进入激战支援即可挑战。无需重启服务。")
                                .setPositiveButton("知道了", null)
                                .show()
                        }.onFailure { error ->
                            save.isEnabled = true
                            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled = true
                            dialog.setCancelable(true)
                            save.text = "保存并切换"
                            showFierceBossError(error)
                        }
                    }
                }.start()
            }
        }
        dialog.show()
        if (state.warning.isNotBlank()) appendLog(state.warning)
    }

    private fun showFierceBossError(error: Throwable) {
        AlertDialog.Builder(this)
            .setTitle("激战支援 Boss")
            .setMessage(error.message ?: "Boss 配置暂不可用，请稍后重试。")
            .setPositiveButton("知道了", null)
            .show()
    }

    private fun waitForUserManager(settings: RevivalSideSettings, token: Int, url: String, attempt: Int) {
        if (token != startFlowToken) return
        if (attempt == 0) listenerStatusText.text = "Opening user manager"
        Thread {
            val ready = isListenerHealthReady(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (ready) {
                    listenerStatusText.text = "Listener ready"
                    appendLog("User manager ready")
                    setUserManagerButtonBusy(false)
                    openUrl(url)
                    return@runOnUiThread
                }
                if (listenerHealthTimedOut()) {
                    appendLog("User manager timed out")
                    setUserManagerButtonBusy(false)
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) {
                    appendLog("Still waiting for user manager (${attempt}s)")
                }
                handler.postDelayed({
                    waitForUserManager(settings, token, url, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun launchCounterSide() {
        val settings = saveSettingsFromInputs()
        val launch = packageManager.getLaunchIntentForPackage(settings.targetPackage)
            ?: Intent(Intent.ACTION_MAIN).apply {
                setClassName(settings.targetPackage, "${settings.targetPackage}.CustomActivity")
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
        launch.addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        runCatching {
            startActivity(launch)
        }.onSuccess {
            appendLog("CounterSide launch intent sent")
        }.onFailure {
            appendLog("CounterSide launch failed: ${it.message}")
        }
    }

    private fun shareLatestExport() {
        val file = CaptureRepository.latestExport(this)
        if (file == null) {
            appendLog("No export is available yet")
            return
        }
        val uri = Uri.Builder()
            .scheme("content")
            .authority("dev.revivalside.officialprofilecapture.exports")
            .appendPath(file.name)
            .build()
        val share = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(share, "Share RevivalSide capture bundle"))
    }

    private fun exportSaveAndLogs() {
        appendLog("Exporting save and diagnostic logs")
        Thread {
            val result = runCatching { CaptureRepository.saveDiagnostics(applicationContext) }
            runOnUiThread {
                result.onSuccess { file ->
                    exportText.text = file.absolutePath
                    appendLog("Save and logs exported: ${file.name}")
                    shareLatestExport()
                }.onFailure { error ->
                    appendLog("Save/log export failed: ${error.message}")
                }
            }
        }.start()
    }

    private fun userManagerUrl(settings: RevivalSideSettings): String {
        return "http://127.0.0.1:${settings.httpPort}/user-manager"
    }

    private fun openUrl(url: String) {
        val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addCategory(Intent.CATEGORY_BROWSABLE)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        runCatching {
            startActivity(browserIntent)
            appendLog("Browser open intent sent")
        }.onFailure {
            appendLog("Could not open $url: ${it.message}")
        }
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    private fun registerStatusReceiver() {
        val filter = IntentFilter().apply {
            addAction(CounterSideVpnService.ACTION_STATUS)
            addAction(RevivalSideListenerService.ACTION_STATUS)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(statusReceiver, filter, INTERNAL_BROADCAST_PERMISSION, null)
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 45)
        }
    }

    private fun saveSettingsFromInputs(): RevivalSideSettings {
        val gamePort = RevivalSideSettingsStore.parsePort(gamePortInput.text.toString(), DEFAULT_GAME_PORT)
        val settings = RevivalSideSettings(
            targetPackage = packageInput.text.toString().trim().ifBlank { DEFAULT_COUNTERSIDE_PACKAGE },
            gamePort = gamePort,
            httpPort = RevivalSideSettingsStore.parsePort(httpPortInput.text.toString(), DEFAULT_HTTP_PORT),
            assetCdnBaseUrl = RevivalSideSettingsStore.normalizeAssetCdnUrl(assetCdnInput.text.toString()),
            redirectPorts = RevivalSideSettingsStore.parsePorts(redirectPortsInput.text.toString(), setOf(gamePort)),
            eventDate = eventDateInput.text.toString().trim(),
            loginBackground = RevivalSideSettingsStore.normalizeLoginBackground(loginBackgroundInput.text.toString()),
            joinLobbyAckMode = RevivalSideSettingsStore.normalizeJoinLobbyAckMode(joinLobbyAckInput.text.toString()),
            nodePath = nodePathInput.text.toString().trim(),
            dotnetPath = dotnetPathInput.text.toString().trim(),
        )
        RevivalSideSettingsStore.save(this, settings)
        return settings
    }

    private fun appendLog(message: String) {
        if (!::logText.isInitialized) return
        val line = "[${LocalTime.now().format(timeFormat)}] $message"
        logText.text = if (logText.text.isNullOrBlank()) line else "${logText.text}\n$line"
    }

    private fun panel(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(16))
            background = rounded(0xd90a0f19.toInt(), dp(12), 0x335f7ea0)
        }
    }

    private fun eyebrow(text: String): TextView {
        return TextView(this).apply {
            this.text = text.uppercase()
            textSize = 11f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xff93c5fd.toInt())
            setPadding(0, 0, 0, dp(8))
        }
    }

    private fun chipRow(vararg chips: View): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.START
            setPadding(0, dp(4), 0, 0)
            chips.forEachIndexed { index, chip ->
                if (index > 0) addView(Space(this@MainActivity), LinearLayout.LayoutParams(dp(8), 1))
                addView(chip, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            }
        }
    }

    private fun chip(title: String, value: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(0x66182739, dp(10), 0x246ea8fe)
            addView(TextView(this@MainActivity).apply {
                text = title.uppercase()
                textSize = 10f
                setTextColor(0xff94a3b8.toInt())
            })
            addView(TextView(this@MainActivity).apply {
                text = value
                textSize = 14f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xfff8fafc.toInt())
                maxLines = 2
            })
        }
    }

    private fun userManagerButton(): Button {
        return Button(this).apply {
            text = "USER MANAGER"
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xfff8fafc.toInt())
            background = rounded(0xff102033.toInt(), dp(10), 0xff38bdf8.toInt())
            setPadding(dp(14), 0, dp(14), 0)
            minHeight = dp(54)
            setOnClickListener { openUserManager() }
        }.also {
            userManagerOpenButton = it
        }
    }

    private fun createPayloadImportButton(): Button {
        return Button(this).apply {
            text = "IMPORT PAYLOAD ZIP"
            textSize = 15f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xffd1fae5.toInt())
            background = rounded(0xff071a14.toInt(), dp(10), 0xff34d399.toInt())
            setPadding(dp(14), 0, dp(14), 0)
            minHeight = dp(54)
            setOnClickListener { openPayloadZipPicker() }
        }.also {
            payloadImportButton = it
        }
    }

    private fun setPayloadImportBusy(busy: Boolean) {
        if (!::payloadImportButton.isInitialized) return
        payloadImportButton.isEnabled = !busy
        payloadImportButton.alpha = if (busy) 0.72f else 1f
        payloadImportButton.text = if (busy) "IMPORTING..." else "IMPORT PAYLOAD ZIP"
        if (::startButton.isInitialized) startButton.isEnabled = !busy
    }

    private fun setUserManagerButtonBusy(busy: Boolean) {
        if (!::userManagerOpenButton.isInitialized) return
        userManagerOpenButton.isEnabled = !busy
        userManagerOpenButton.alpha = if (busy) 0.72f else 1f
        userManagerOpenButton.text = if (busy) "OPENING..." else "USER MANAGER"
    }

    private fun mutedText(text: String, size: Float): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = size
            setTextColor(0xffcbd5e1.toInt())
            setPadding(0, dp(2), 0, 0)
        }
    }

    private fun label(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 12f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xff94a3b8.toInt())
            setPadding(0, dp(10), 0, dp(3))
        }
    }

    private fun statusText(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 20f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xfff8fafc.toInt())
            setPadding(0, dp(1), 0, dp(6))
        }
    }

    private fun singleLineInput(value: String): EditText {
        return EditText(this).apply {
            setSingleLine(true)
            setText(value)
            textSize = 15f
            setTextColor(0xfff8fafc.toInt())
            setHintTextColor(0xff64748b.toInt())
            setPadding(dp(12), 0, dp(12), 0)
            minHeight = dp(48)
            background = rounded(0x6606090d, dp(9), 0x3364748b)
        }
    }

    private fun numberInput(value: String): EditText {
        return singleLineInput(value).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
        }
    }

    private fun fieldColumn(title: String, input: EditText): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, dp(10), 0)
            addView(label(title))
            addView(input, fillWrap())
        }
    }

    private fun fillWrap(): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    private fun fillWrapWithBottom(bottom: Int): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = bottom
        }
    }

    private fun rounded(color: Int, radius: Int, strokeColor: Int = 0): GradientDrawable {
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius.toFloat()
            if (strokeColor != 0) setStroke(dp(1), strokeColor)
        }
    }

    private fun verticalGradient(top: Int, bottom: Int): GradientDrawable {
        return GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(top, bottom))
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val VPN_REQUEST = 100
        const val PAYLOAD_ZIP_REQUEST = 101
        const val LISTENER_HEALTH_TIMEOUT_MS = 240000L
        const val LISTENER_HEALTH_INTERVAL_MS = 1000L
        const val LISTENER_WARMUP_CONNECT_TIMEOUT_MS = 2000
        const val LISTENER_WARMUP_READ_TIMEOUT_MS = 240000
        const val SERVER_MODE_REVIVALSIDE = "revivalside"
        const val SERVER_MODE_OFFICIAL = "official"
    }

    private data class WarmupResult(val ok: Boolean, val summary: String = "")
    private data class ListenerHealth(val ready: Boolean, val fatalMessage: String = "")
    private data class ServerInfoModeResult(val ok: Boolean, val summary: String = "")

    private data class ImportResult(val ok: Boolean, val summary: String = "")
}
