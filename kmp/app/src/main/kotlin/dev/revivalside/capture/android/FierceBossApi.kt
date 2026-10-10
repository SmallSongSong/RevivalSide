package dev.revivalside.capture.android

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

internal data class FierceBossOption(val seasonId: Int, val name: String)

internal data class FierceBossState(
    val port: Int,
    val seasonId: Int,
    val activeName: String,
    val options: List<FierceBossOption>,
    val warning: String,
)

internal object FierceBossApi {
    fun load(httpPort: Int): FierceBossState {
        // Legacy launchers serve CDN traffic on HTTP and the Node APIs on HTTP + 1.
        for (port in listOf(httpPort, httpPort + 1).filter { it in 1..65535 }.distinct()) {
            try {
                return request(port, "GET")
            } catch (error: ApiFailure) {
                if (error.status != 404 && error.status != 405) throw error
            } catch (_: java.io.IOException) {
                // Try the companion API port when the CDN endpoint is unavailable.
            } catch (_: org.json.JSONException) {
                // A CDN HTML response does not identify the management API.
            }
        }
        throw IllegalStateException("无法连接 Boss 配置。请先点击 START 启动服务，再重试；若服务已启动，请确认已安装带有 Boss 配置的新版本。")
    }

    fun save(port: Int, seasonId: Int): FierceBossState = request(port, "PUT", seasonId)

    private fun request(port: Int, method: String, seasonId: Int? = null): FierceBossState {
        val connection = URL("http://127.0.0.1:$port/user-manager/api/fierce-boss").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 2500
            connection.readTimeout = 5000
            connection.instanceFollowRedirects = false
            if (seasonId != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(JSONObject().put("seasonId", seasonId).toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val detail = runCatching { JSONObject(body).optString("error") }.getOrDefault("")
                val message = if (status == 409) "激战支援战斗正在进行，请完成或退出战斗后再切换。"
                    else detail.ifBlank { "Boss 配置请求失败（$status），请稍后重试。" }
                throw ApiFailure(status, message)
            }
            val data = JSONObject(body)
            val rows = data.getJSONArray("options")
            val options = (0 until rows.length()).map { index ->
                val row = rows.getJSONObject(index)
                FierceBossOption(row.getInt("seasonId"), row.getString("name"))
            }
            return FierceBossState(port, data.getInt("seasonId"), data.getString("activeName"), options, data.optString("warning"))
        } finally {
            connection.disconnect()
        }
    }

    private class ApiFailure(val status: Int, message: String) : IllegalStateException(message)
}
