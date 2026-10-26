// -*- coding: utf-8 -*-
/**
 SceneDelegate.swift
 Mobile Scene Lifecycle
 =====================
 Hosts the Codex controller and forwards system scene events to Capacitor.
 */
import UIKit

import Capacitor

/**
 Mobile application scene.
 Retains the controller that registers the embedded Codex runtime.
 */
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /**
     Connect the scene to the Codex interface.

     Args:
         scene (UIScene): Scene provided by the operating system.
         session (UISceneSession): Persistent scene session.
         connectionOptions (UIScene.ConnectionOptions): Initial scene events.
     Returns:
         Void: The Codex controller is visible and the native bridge is registered.
     */
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // Require a window scene before creating the interface container.
        guard let windowScene = scene as? UIWindowScene else { return }

        // Retain the storyboard window or create the same Codex host programmatically.
        if window == nil {
            window = UIWindow(windowScene: windowScene)
            window?.rootViewController = CodexViewController()
        }
        // Present the controller that owns native plugin registration.
        window?.makeKeyAndVisible()

        // Forward the initial scene events through the existing Capacitor lifecycle.
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /**
     Forward URLs opened by the operating system.

     Args:
         scene (UIScene): Scene receiving the URL event.
         URLContexts (Set<UIOpenURLContext>): URLs and their opening options.
     Returns:
         Void: Capacitor receives the original URL event.
     */
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // Preserve the existing native URL handling contract.
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    /**
     Forward continuing user activity to the native bridge.

     Args:
         scene (UIScene): Scene receiving the activity.
         userActivity (NSUserActivity): Activity supplied by the operating system.
     Returns:
         Void: Capacitor receives the original activity.
     */
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        // Preserve the existing native activity handling contract.
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
