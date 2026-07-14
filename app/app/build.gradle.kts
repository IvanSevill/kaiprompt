plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.kaiprompt.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.kaiprompt.app"
        minSdk = 26                       // AES-GCM + foreground services behave from here up
        targetSdk = 35
        versionCode = 6
        versionName = "1.3.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the debug key on purpose: this APK is meant to be sideloaded from
            // your own machine, not shipped through Play. A release build that cannot be
            // installed would be a strange thing to hand someone.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { compose = true }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")

    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.8.5")

    implementation("androidx.work:work-runtime-ktx:2.10.0")

    // QR scanning. ZXing rather than ML Kit: no Google Play Services dependency, so the app
    // works on a phone that has been degoogled — which is the sort of phone whose owner also
    // runs a firewall like NetGuard.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
    // Android ships org.json, but the JVM does not — without this the unit tests get
    // Android's stub, whose every method throws. That is what makes the core logic
    // (crypto, parsing) verifiable on the machine that builds the app, with no emulator.
    testImplementation("org.json:json:20240303")
}
