import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";

import { useAuth } from "@/hooks/use-auth";
import { signIn as signInAction, signUp as signUpAction } from "@/actions";
import { getAnonWorkData, clearAnonWork } from "@/lib/anon-work-tracker";
import { getProjects } from "@/actions/get-projects";
import { createProject } from "@/actions/create-project";
import { useRouter } from "next/navigation";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@/actions", () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock("@/lib/anon-work-tracker", () => ({
  getAnonWorkData: vi.fn(),
  clearAnonWork: vi.fn(),
}));

vi.mock("@/actions/get-projects", () => ({
  getProjects: vi.fn(),
}));

vi.mock("@/actions/create-project", () => ({
  createProject: vi.fn(),
}));

describe("useAuth", () => {
  const mockPush = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as any).mockReturnValue({ push: mockPush });
    // Default: no anon work, no projects — keeps each test self-contained.
    (getAnonWorkData as any).mockReturnValue(null);
    (getProjects as any).mockResolvedValue([]);
    (createProject as any).mockResolvedValue({ id: "default-project" });
  });

  afterEach(() => {
    cleanup();
  });

  test("returns initial state with isLoading=false and stable handlers", () => {
    const { result } = renderHook(() => useAuth());

    expect(result.current.isLoading).toBe(false);
    expect(typeof result.current.signIn).toBe("function");
    expect(typeof result.current.signUp).toBe("function");
  });

  describe("signIn", () => {
    test("on successful sign in with no anon work and no existing projects, creates a new project and navigates to it", async () => {
      (signInAction as any).mockResolvedValue({ success: true });
      (getAnonWorkData as any).mockReturnValue(null);
      (getProjects as any).mockResolvedValue([]);
      (createProject as any).mockResolvedValue({ id: "new-project-id" });

      const { result } = renderHook(() => useAuth());

      let returned: any;
      await act(async () => {
        returned = await result.current.signIn("user@example.com", "password123");
      });

      expect(signInAction).toHaveBeenCalledWith("user@example.com", "password123");
      expect(returned).toEqual({ success: true });
      expect(createProject).toHaveBeenCalledTimes(1);
      const createArgs = (createProject as any).mock.calls[0][0];
      expect(createArgs.messages).toEqual([]);
      expect(createArgs.data).toEqual({});
      expect(createArgs.name).toMatch(/^New Design #\d+$/);
      expect(mockPush).toHaveBeenCalledWith("/new-project-id");
      expect(clearAnonWork).not.toHaveBeenCalled();
    });

    test("on successful sign in with no anon work but existing projects, navigates to the most recent project", async () => {
      (signInAction as any).mockResolvedValue({ success: true });
      (getAnonWorkData as any).mockReturnValue(null);
      (getProjects as any).mockResolvedValue([
        { id: "recent-1" },
        { id: "older-2" },
      ]);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signIn("a@b.com", "secret-pw");
      });

      expect(mockPush).toHaveBeenCalledWith("/recent-1");
      expect(createProject).not.toHaveBeenCalled();
      expect(clearAnonWork).not.toHaveBeenCalled();
    });

    test("on successful sign in with anon work, migrates it into a new project and clears tracker", async () => {
      const anonMessages = [{ id: "m1", role: "user", content: "Hi" }];
      const anonFs = { "/App.jsx": { type: "file", content: "x" } };

      (signInAction as any).mockResolvedValue({ success: true });
      (getAnonWorkData as any).mockReturnValue({
        messages: anonMessages,
        fileSystemData: anonFs,
      });
      (createProject as any).mockResolvedValue({ id: "migrated-project" });

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signIn("a@b.com", "password123");
      });

      expect(createProject).toHaveBeenCalledTimes(1);
      const createArgs = (createProject as any).mock.calls[0][0];
      expect(createArgs.messages).toBe(anonMessages);
      expect(createArgs.data).toBe(anonFs);
      expect(createArgs.name).toMatch(/^Design from /);

      expect(clearAnonWork).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith("/migrated-project");
      // We should not have asked for the user's projects when anon work took precedence.
      expect(getProjects).not.toHaveBeenCalled();
    });

    test("falls back to the projects flow when anon work exists but has no messages", async () => {
      (signInAction as any).mockResolvedValue({ success: true });
      (getAnonWorkData as any).mockReturnValue({
        messages: [],
        fileSystemData: {},
      });
      (getProjects as any).mockResolvedValue([{ id: "existing-only" }]);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signIn("a@b.com", "password123");
      });

      expect(clearAnonWork).not.toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith("/existing-only");
    });

    test("on failed sign in, returns the error result and does not run post-sign-in logic", async () => {
      (signInAction as any).mockResolvedValue({
        success: false,
        error: "Invalid credentials",
      });

      const { result } = renderHook(() => useAuth());

      let returned: any;
      await act(async () => {
        returned = await result.current.signIn("a@b.com", "wrong");
      });

      expect(returned).toEqual({ success: false, error: "Invalid credentials" });
      expect(getAnonWorkData).not.toHaveBeenCalled();
      expect(getProjects).not.toHaveBeenCalled();
      expect(createProject).not.toHaveBeenCalled();
      expect(clearAnonWork).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    test("sets isLoading=true while the action runs and resets to false afterward", async () => {
      let resolveAction: (v: any) => void;
      (signInAction as any).mockReturnValue(
        new Promise((resolve) => {
          resolveAction = resolve;
        })
      );

      const { result } = renderHook(() => useAuth());

      let signInPromise: Promise<any>;
      act(() => {
        signInPromise = result.current.signIn("a@b.com", "password123");
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      await act(async () => {
        resolveAction!({ success: false });
        await signInPromise!;
      });

      expect(result.current.isLoading).toBe(false);
    });

    test("resets isLoading to false even when the action throws", async () => {
      (signInAction as any).mockRejectedValue(new Error("network down"));

      const { result } = renderHook(() => useAuth());

      await expect(
        act(async () => {
          await result.current.signIn("a@b.com", "password123");
        })
      ).rejects.toThrow("network down");

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe("signUp", () => {
    test("on successful sign up with no anon work and no projects, creates a new project and navigates", async () => {
      (signUpAction as any).mockResolvedValue({ success: true });
      (getAnonWorkData as any).mockReturnValue(null);
      (getProjects as any).mockResolvedValue([]);
      (createProject as any).mockResolvedValue({ id: "fresh-signup-project" });

      const { result } = renderHook(() => useAuth());

      let returned: any;
      await act(async () => {
        returned = await result.current.signUp("new@user.com", "password123");
      });

      expect(signUpAction).toHaveBeenCalledWith("new@user.com", "password123");
      expect(returned).toEqual({ success: true });
      expect(createProject).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith("/fresh-signup-project");
    });

    test("on successful sign up with anon work, migrates it into a new project", async () => {
      const anonMessages = [{ id: "m1", role: "user", content: "Hi" }];
      const anonFs = { "/App.jsx": { type: "file", content: "x" } };

      (signUpAction as any).mockResolvedValue({ success: true });
      (getAnonWorkData as any).mockReturnValue({
        messages: anonMessages,
        fileSystemData: anonFs,
      });
      (createProject as any).mockResolvedValue({ id: "migrated-on-signup" });

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signUp("new@user.com", "password123");
      });

      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: anonMessages,
          data: anonFs,
        })
      );
      expect(clearAnonWork).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith("/migrated-on-signup");
      expect(getProjects).not.toHaveBeenCalled();
    });

    test("on failed sign up, returns error and skips post-sign-in logic", async () => {
      (signUpAction as any).mockResolvedValue({
        success: false,
        error: "Email already registered",
      });

      const { result } = renderHook(() => useAuth());

      let returned: any;
      await act(async () => {
        returned = await result.current.signUp("dupe@user.com", "password123");
      });

      expect(returned).toEqual({
        success: false,
        error: "Email already registered",
      });
      expect(getAnonWorkData).not.toHaveBeenCalled();
      expect(createProject).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    test("sets isLoading=true during sign up and resets to false afterward", async () => {
      let resolveAction: (v: any) => void;
      (signUpAction as any).mockReturnValue(
        new Promise((resolve) => {
          resolveAction = resolve;
        })
      );

      const { result } = renderHook(() => useAuth());

      let signUpPromise: Promise<any>;
      act(() => {
        signUpPromise = result.current.signUp("new@user.com", "password123");
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(true);
      });

      await act(async () => {
        resolveAction!({ success: false });
        await signUpPromise!;
      });

      expect(result.current.isLoading).toBe(false);
    });

    test("resets isLoading to false even when sign up throws", async () => {
      (signUpAction as any).mockRejectedValue(new Error("boom"));

      const { result } = renderHook(() => useAuth());

      await expect(
        act(async () => {
          await result.current.signUp("new@user.com", "password123");
        })
      ).rejects.toThrow("boom");

      expect(result.current.isLoading).toBe(false);
    });
  });
});
