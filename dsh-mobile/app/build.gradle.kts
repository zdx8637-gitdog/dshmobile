import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.dshmobile.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.dshmobile.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        create("release") {
            // 签名密钥不入仓库：keystore 文件（../release.keystore）与口令均只存在于
            // 本机 local.properties（或环境变量 DSHMOBILE_*），见仓库 README 隐私说明。
            val localProps = Properties().apply {
                val f = rootProject.file("local.properties")
                if (f.exists()) f.inputStream().use { load(it) }
            }
            fun secret(key: String, env: String) =
                localProps.getProperty(key) ?: System.getenv(env) ?: ""
            storeFile = file("../release.keystore")
            storePassword = secret("dshmobile.storePassword", "DSHMOBILE_STORE_PASSWORD")
            keyAlias = secret("dshmobile.keyAlias", "DSHMOBILE_KEY_ALIAS").ifEmpty { "dshmobile" }
            keyPassword = secret("dshmobile.keyPassword", "DSHMOBILE_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    // 允许明文 HTTP 仅用于调试期测试服务器（正式版本切 HTTPS 后移除）
    // Android 上默认禁止 cleartext；服务器已全量 HTTPS，故保持默认禁止。
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.zxing.embedded)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
